---
name: Replit managed DB schema push
description: The Replit-managed PostgreSQL needs a separate Drizzle schema push on fresh import; the local Postgres workflow doesn't push to it.
---

# Replit managed DB schema push

## The rule
On a fresh GitHub import into Replit, run `pnpm --filter @workspace/db run push --config ./drizzle.config.ts` from the workspace root before starting the API Server workflow. The artifact workflow uses Replit's injected `DATABASE_URL` (pointing to a managed Replit PostgreSQL instance), not the local Postgres started by `scripts/start-postgres.sh`.

**Why:** The local Postgres workflow (`scripts/start-postgres.sh`) pushes the Drizzle schema only to its own local instance at `127.0.0.1:5432/equilibrium`. The `artifacts/api-server: API Server` artifact workflow receives a different `DATABASE_URL` injected by Replit (a managed cloud database). The tables don't exist there until you push explicitly.

**How to apply:** Whenever the API server logs `relation "blocks" does not exist` after a fresh import/clone, run the push command above (the shell `DATABASE_URL` env var picks up Replit's injected value automatically). The `scripts/setup-replit.sh` script automates this.
