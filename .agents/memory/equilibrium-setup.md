---
name: Equilibrium project setup
description: Workflow config, port assignments, and known route conflict for the Equilibrium blockchain project
---

## Workflow commands

- API Server: `PORT=8080 pnpm --filter @workspace/api-server run dev` — waitForPort 8080, console output
- Explorer: `PORT=20087 BASE_PATH=/explorer/ pnpm --filter @workspace/explorer run dev` — webview output, port 20087

**Why:** The artifact.toml files have localPort hardcoded (8080 / 20087). PORT must be set inline in the workflow command because the workflow system doesn't read from artifact.toml env blocks.

## Route conflict

`/api/blocks/headers` is caught by `/api/blocks/:hashOrHeight` in the blocks router (registered first). The headers-first sync endpoint must live at `/api/sync/headers`.

**How to apply:** Any new route that could match an existing `:param` must either be registered before that router in index.ts, or use a path that doesn't collide.

## Architecture summary

- `artifacts/api-server/src/chain/state.ts` — single ChainState singleton with: Ledger, Mempool, adaptive difficulty, validator set, BFT finality rounds, DEX AMM pools, staking/unbonding, gossip log
- `artifacts/api-server/src/routes/` — one file per feature domain (validators, dex, staking, network, faucet, metrics)
- Prometheus metrics at `/metrics` (not under /api) — registered directly on app, not on the api sub-router
