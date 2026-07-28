#!/usr/bin/env bash
# One-shot setup for a fresh Replit import (GitHub → Replit).
#
# Run this once after importing the project. It:
#   1. Installs Node dependencies (pnpm install)
#   2. Pushes the Drizzle schema to Replit's managed PostgreSQL
#      (the artifact API Server workflow uses DATABASE_URL injected by Replit,
#       which points to a managed cloud DB — distinct from the local Postgres
#       started by scripts/start-postgres.sh)
#
# Usage:
#   bash scripts/setup-replit.sh
#
# After this completes, start workflows in order:
#   Postgres → API Server → Explorer

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "[setup] Installing Node dependencies…"
pnpm install --frozen-lockfile
echo "[setup] pnpm install complete."

echo "[setup] Pushing Drizzle schema to managed database…"
pnpm --filter @workspace/db run push --config ./drizzle.config.ts
echo "[setup] Schema push complete."

echo ""
echo "[setup] ✓ Done. Start workflows in Replit in this order:"
echo "         1. Postgres"
echo "         2. API Server"
echo "         3. Explorer"
