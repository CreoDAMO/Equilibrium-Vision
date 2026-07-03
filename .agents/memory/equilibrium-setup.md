---
name: Equilibrium setup & architecture
description: Run commands, port assignments, known quirks, and encoding conventions for the Equilibrium blockchain project.
---

## Run commands
- Postgres:    `bash scripts/start-postgres.sh` (console workflow, no port check — 5432 not in Replit supported list)
- API Server:  `DATABASE_URL=postgresql://runner@127.0.0.1:5432/equilibrium PORT=8080 pnpm --filter @workspace/api-server run dev` (console workflow, port 8080)
- Explorer:    `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/explorer run dev` (webview workflow, port 5000)
- Explorer Vite proxies /api and /ws → localhost:8080, so API Server must be running first.
- Before typechecking api-server: run `pnpm run typecheck:libs` first (builds lib/api-zod dist).

## Port assignments
- API Server: 8080 (console workflow)
- Explorer: 5000 (webview workflow) — was 20087 originally but 20087 is not in Replit's supported port list; changed to 5000 with BASE_PATH=/.
- Postgres: 5432 — not in Replit's supported waitForPort list; configure workflow without waitForPort.

## Postgres self-hosted setup
- Data dir: `.pgdata/` (gitignored). Initialized by `scripts/start-postgres.sh` on first run.
- `initdb` on this Nix system creates superuser named `postgres`, not the OS user. The startup script creates the OS-user role (e.g. `runner`) after boot.
- DATABASE_URL is blocked from setEnvVars (Replit runtime-managed name). Pass it inline in the workflow command instead.
- Schema migration: `DATABASE_URL=... pnpm --filter @workspace/db run push` — must be run once after first boot.
- lib/db/src/index.ts throws immediately if DATABASE_URL not set — never import it statically from api-server. Import `@workspace/db/schema` only (safe).

## Postgres persistence layer
- `artifacts/api-server/src/chain/persistence.ts`: lazy singleton drizzle client; returns null when DATABASE_URL absent → pure in-memory fallback.
- `loadBlocksFromDb()`: validates contiguous heights + prevHash linkage before replay; falls back to genesis on any integrity failure.
- `persistBlock()`: fire-and-forget; errors logged but never thrown (never blocks mining loop).
- Genesis persist: awaited in `initChain()` before server.listen(), so DB is consistent before mining starts.
- Known limitation: `buildChainFromBlocks()` replays via `addBlock()` which may produce slightly different derived state (balances, UTXOs) vs original genesis builder path. Chain history (hashes, txs) is correct. Acceptable for testnet.

## Route conflicts (historical)
- /api/blocks/headers conflicts with /api/blocks/:hashOrHeight — use /api/sync/headers instead.

## ZK encoding — single source of truth
- `artifacts/api-server/src/chain/zk-encoding.ts` holds canonical `fpEncode()` and `blockHashToFields()`.
- Both `zkproof.ts` (TS fallback prover) and `consensus-bridge.ts` (Rust sidecar bridge) import from zk-encoding.ts.
- `zkproof.ts` re-exports `blockHashToFields as encodeBlockHash` for backward compat with existing callers.
- **Why:** Prior to this, the bridge used Math.round and inline hash splitting; the TS prover used Math.floor with a different helper. They produced different public inputs for the same block, breaking proof verification.

## Mining loop (stop-safety)
- `artifacts/api-server/src/chain/index.ts` uses setTimeout recursion + generation-token pattern, NOT setInterval.
- `miningGeneration` is incremented on both `startMining()` and `stopMining()`.
- `runMiningCycle(generation)` only reschedules in `finally` if `generation === miningGeneration && miningEnabled`.
- **Why:** setInterval with async mining (or rapid stop→start) can create duplicate concurrent cycles. Generation token makes any in-flight cycle's finally block see a stale generation and exit without rescheduling.

## Rust sidecar
- Binary path: `equilibrium/target/release/consensus-api` (not built by default — cargo build takes several minutes).
- Bridge in `consensus-bridge.ts` falls back to TS prover silently when sidecar is unavailable.
- The TS prover (zkproof.ts) is NOT a real ZK circuit proof — it derives valid BN254 curve points deterministically but without a circuit witness.
