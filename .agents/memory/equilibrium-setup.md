---
name: Equilibrium project setup
description: Workflow config, port assignments, and known route conflict for the Equilibrium blockchain project
---

## Workflow commands

Managed artifact workflows (created automatically from artifact.toml — do not recreate manually):
- `artifacts/api-server: API Server` — runs `pnpm --filter @workspace/api-server run dev`, port 8080, console
- `artifacts/explorer: web` — runs `pnpm --filter @workspace/explorer run dev`, port 5000, webview

**Why:** After artifact registration, Replit creates managed workflows that inject [services.env] (PORT, BASE_PATH) automatically. Do not create manual workflows for these services — they conflict and cause EADDRINUSE on restart.

**Port kill:** If both workflows fail with EADDRINUSE after a workflow removal, the old processes linger. Kill by PID (`ps aux | grep pnpm`, then `kill -9 <pids>`) before restarting managed workflows.

## Explorer base path

Explorer artifact.toml: `paths = ["/"]`, `BASE_PATH = "/"`, `localPort = 5000`.
Previously was `/explorer/` which caused a 404 at the root URL in deployment.

## Route conflict

`/api/blocks/headers` is caught by `/api/blocks/:hashOrHeight` in the blocks router (registered first). The headers-first sync endpoint must live at `/api/sync/headers`.

**How to apply:** Any new route that could match an existing `:param` must either be registered before that router in index.ts, or use a path that doesn't collide.

## Architecture summary

- `artifacts/api-server/src/chain/state.ts` — single ChainState singleton with: Ledger, Mempool, adaptive difficulty, validator set, BFT finality rounds, DEX AMM pools, staking/unbonding, gossip log
- `artifacts/api-server/src/routes/` — one file per feature domain (validators, dex, staking, network, faucet, metrics)
- Prometheus metrics at `/metrics` (not under /api) — registered directly on app, not on the api sub-router
