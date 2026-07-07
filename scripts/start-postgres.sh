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
# Unset Replit-injected PG env vars that point at a managed cloud DB — they
# would misdirect any psql/createdb call that doesn't pass explicit flags.
unset PGHOST PGPASSWORD PGDATABASE
# Use the OS user as the default superuser name (Replit sets PGUSER=postgres
# via its managed-DB injection, which we do NOT want here).
PGUSER="$(whoami)"
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
psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -d postgres -tc \
  "SELECT 1 FROM pg_roles WHERE rolname='$OS_USER'" 2>/dev/null \
  | grep -q 1 \
  || { psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -d postgres \
         -c "CREATE ROLE \"$OS_USER\" WITH LOGIN SUPERUSER;" \
       && echo "[postgres] Created role '$OS_USER'."; }

# Also ensure the 'runner' role always exists (API server connects as runner).
# Use a DO block so the CREATE is atomic — no TOCTOU race between check and create.
psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -d postgres -c \
  "DO \$\$ BEGIN
     CREATE ROLE runner WITH LOGIN SUPERUSER;
   EXCEPTION WHEN duplicate_object THEN NULL;
   END \$\$;" \
  && echo "[postgres] Role 'runner' ensured."

# Create application database if missing
if ! psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDB"; then
  echo "[postgres] Creating database '$PGDB' …"
  createdb -p "$PGPORT" -h 127.0.0.1 -U "$SU" "$PGDB"
fi

# Ensure node_modules exist before pushing schema — on a cold boot (fresh
# clone or GitHub import) node_modules may not yet be present, which would
# cause the pnpm filter command to fail silently.
REPO_ROOT_ABS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ ! -d "$REPO_ROOT_ABS/node_modules" ]; then
  echo "[postgres] node_modules missing — running pnpm install before schema push …"
  (cd "$REPO_ROOT_ABS" && pnpm install --frozen-lockfile 2>&1 | tail -5) \
    && echo "[postgres] pnpm install complete." \
    || echo "[postgres] pnpm install failed — schema push may not succeed."
fi

# Push schema using the superuser so it always succeeds even if runner role
# was just created moments ago.  Fall back to OS_USER if SU fails.
PGDB_URL_SU="postgresql://${SU}@127.0.0.1:${PGPORT}/${PGDB}"
PGDB_URL_OS="postgresql://${OS_USER}@127.0.0.1:${PGPORT}/${PGDB}"
if (cd "$REPO_ROOT_ABS" && DATABASE_URL="$PGDB_URL_SU" pnpm --filter @workspace/db run push --config ./drizzle.config.ts 2>&1 | grep -E "Changes applied|No changes"); then
  echo "[postgres] Schema up to date (via $SU)."
elif (cd "$REPO_ROOT_ABS" && DATABASE_URL="$PGDB_URL_OS" pnpm --filter @workspace/db run push --config ./drizzle.config.ts > /dev/null 2>&1); then
  echo "[postgres] Schema up to date (via $OS_USER)."
else
  echo "[postgres] Schema push skipped (will retry next boot)."
fi

# Grant runner full access to all tables/sequences (schema may have been pushed
# as the superuser, leaving runner without table-level permissions).
psql -p "$PGPORT" -h 127.0.0.1 -U "$SU" -d "$PGDB" -c \
  "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO runner;
   GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO runner;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO runner;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO runner;" \
  > /dev/null 2>&1 \
  && echo "[postgres] Granted table/sequence access to runner."

pg_ctl stop -D "$PGDATA" -m fast -w
echo "[postgres] Starting in foreground on port $PGPORT …"

# Run in the foreground so the workflow process stays alive
exec postgres -D "$PGDATA"
