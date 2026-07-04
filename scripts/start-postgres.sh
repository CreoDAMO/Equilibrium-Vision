#!/usr/bin/env bash
# Start a self-hosted PostgreSQL instance in the FOREGROUND.
# Designed to be used as a long-running workflow process.
# On first run it initialises the data directory and creates the application database.
#
# Works on any system that has pg_ctl/initdb/postgres in PATH
# (Nix, Homebrew, apt, etc.).
#
# Environment:
#   PGDATA   — data directory  (default: <repo-root>/.pgdata)
#   PGPORT   — TCP port        (default: 5432)
#   PGUSER   — superuser name  (default: current user)
#   PGDB     — database name   (default: equilibrium)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGDATA="${PGDATA:-$REPO_ROOT/.pgdata}"
export PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-$(whoami)}"
PGDB="${PGDB:-equilibrium}"

CUSTOM_CONF="$PGDATA/replit.conf"

# ── Initialise data directory once ───────────────────────────────────────────
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "[postgres] Initialising data directory at $PGDATA …"
  initdb -D "$PGDATA" --auth=trust --username="$PGUSER" 2>&1 | tail -3

  # Write runtime overrides to a separate included file (idempotent)
  cat > "$CUSTOM_CONF" <<EOF
port                    = $PGPORT
listen_addresses        = '127.0.0.1'
unix_socket_directories = '$PGDATA'
EOF
  # Include it from the main config
  echo "include = '$CUSTOM_CONF'" >> "$PGDATA/postgresql.conf"
fi

# ── Ensure application database exists (needs a running server) ───────────────
# Temporarily start in background, create DB, then stop and re-exec foreground.
if pg_ctl status -D "$PGDATA" > /dev/null 2>&1; then
  echo "[postgres] Stopping stale background instance …"
  pg_ctl stop -D "$PGDATA" -m fast -w
fi

pg_ctl start -D "$PGDATA" -l "$PGDATA/server.log" -w
sleep 0.5

# ── Detect which superuser initdb created ────────────────────────────────────
# initdb uses --username= if provided, otherwise the OS user or 'postgres'.
# We try the OS user first, then fall back to 'postgres'.
OS_USER="$(whoami)"
if psql -p "$PGPORT" -h 127.0.0.1 -U "$OS_USER" -c "SELECT 1" postgres > /dev/null 2>&1; then
  SU="$OS_USER"
elif psql -p "$PGPORT" -h 127.0.0.1 -U postgres -c "SELECT 1" postgres > /dev/null 2>&1; then
  SU="postgres"
else
  echo "[postgres] WARNING: could not connect as $OS_USER or postgres — proceeding anyway"
  SU="postgres"
fi
echo "[postgres] Using superuser: $SU"

# Ensure the OS user role exists with login privileges
psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -tc \
  "SELECT 1 FROM pg_roles WHERE rolname='$OS_USER'" 2>/dev/null \
  | grep -q 1 \
  || { psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" \
         -c "CREATE ROLE \"$OS_USER\" WITH LOGIN SUPERUSER;" 2>/dev/null \
       && echo "[postgres] Created role '$OS_USER'."; }

# Also ensure the 'runner' role always exists (API server connects as runner).
# Use a DO block so the CREATE is atomic — no TOCTOU race between check and create.
psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -c \
  "DO \$\$ BEGIN
     CREATE ROLE runner WITH LOGIN SUPERUSER;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END \$\$;" 2>/dev/null \
  && echo "[postgres] Role 'runner' ensured."

# Create application database if missing
if ! psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDB"; then
  echo "[postgres] Creating database '$PGDB' …"
  createdb -p "$PGPORT" -h 127.0.0.1 -U "$SU" "$PGDB"
fi

# Push schema (idempotent — safe to run every boot)
PGDB_URL="postgresql://${OS_USER}@127.0.0.1:${PGPORT}/${PGDB}"
REPO_ROOT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if DATABASE_URL="$PGDB_URL" pnpm --filter @workspace/db run push --config ./drizzle.config.ts > /dev/null 2>&1; then
  echo "[postgres] Schema up to date."
else
  echo "[postgres] Schema push skipped (will retry next boot)."
fi

pg_ctl stop -D "$PGDATA" -m fast -w
echo "[postgres] Starting in foreground on port $PGPORT …"

# Run in the foreground so the workflow process stays alive
exec postgres -D "$PGDATA"
