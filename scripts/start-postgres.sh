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

# Ensure the OS user role exists (initdb may have used 'postgres' as superuser)
OS_USER="$(whoami)"
psql -p "$PGPORT" -h 127.0.0.1 -U postgres -tc \
  "SELECT 1 FROM pg_roles WHERE rolname='$OS_USER'" 2>/dev/null \
  | grep -q 1 \
  || { psql -p "$PGPORT" -h 127.0.0.1 -U postgres \
         -c "CREATE ROLE \"$OS_USER\" WITH LOGIN SUPERUSER;" 2>/dev/null \
       && echo "[postgres] Created role '$OS_USER'."; }

# Create application database if missing
if ! psql -p "$PGPORT" -h 127.0.0.1 -U postgres -lqt 2>/dev/null | cut -d\| -f1 | grep -qw "$PGDB"; then
  echo "[postgres] Creating database '$PGDB' …"
  createdb -p "$PGPORT" -h 127.0.0.1 -U postgres "$PGDB"
fi

pg_ctl stop -D "$PGDATA" -m fast -w
echo "[postgres] Starting in foreground on port $PGPORT …"

# Run in the foreground so the workflow process stays alive
exec postgres -D "$PGDATA"
