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

- `artifacts/api-server/src/chain/state.ts` — single ChainState singleton with: Ledger, Mempool (size/pressure are **getter properties**, not methods), adaptive difficulty, validator set, BFT finality rounds, DEX AMM pools, staking/unbonding, gossip log
- `artifacts/api-server/src/routes/` — one file per feature domain (validators, dex, staking, network, faucet, metrics)
- Prometheus metrics at `/metrics` (not under /api) — registered directly on app, not on the api sub-router

## WebSocket

- Server: `artifacts/api-server/src/lib/ws-server.ts` — `/ws` path, broadcasts `new_block` and `mempool_update`
- index.ts wraps Express in `http.createServer(app)` then calls `createWsServer(server)`
- Explorer hook: `artifacts/explorer/src/hooks/useChainWebSocket.ts` — called in `AppRouter` (inside QueryClientProvider)
- Vite proxy: `/ws` proxied to `ws://localhost:8080` with `ws: true` in both server and preview sections
- Stratum server: `artifacts/api-server/src/lib/stratum-server.ts` — only starts when `STRATUM_PORT` env var is set

## SDK

- `lib/sdk/src/index.ts` — `EquilibriumClient` class (namespaced: chain, blocks, tx, addresses, mempool, validators, dex, faucet) + `subscribeToChain()` WS helper
- `lib/sdk/tsconfig.json` must include `"lib": ["ES2022", "DOM"]` for fetch/WebSocket/URL globals
- `lib/sdk` added to root tsconfig.json project references

## DB schema

- `lib/db/src/schema/blocks.ts`, `transactions.ts`, `validators.ts` — Drizzle/Postgres tables defined
- Not yet wired into api-server (still in-memory) — needs DATABASE_URL + `pnpm run push`

## CI

- `.github/workflows/ci.yml` — typecheck (pnpm) + rust-check (cargo check + clippy) + rust-test jobs

## Android scaffold

- `equilibrium/mobile/android/` — full Gradle project: settings.gradle.kts, build.gradle.kts, app/build.gradle.kts, AndroidManifest.xml, gradle wrapper, libs.versions.toml
- JNI libs expected at `app/src/main/jniLibs/` (built by cargo-ndk)

## iOS scaffold

- `equilibrium/mobile/ios/Package.swift` — Swift package with EquilibriumMiner + EquilibriumCoreStub targets
- `MiningCoordinator.swift` — BackgroundTasks API integration, requires external power + network
- Swap stub for real xcframework: `cargo swift package --platforms ios --name EquilibriumCore`

## Docs

- `docs/testnet-deployment.md` — Hetzner sizing, multi-node libp2p bootstrap, Caddy TLS, Postgres setup, firewall rules
