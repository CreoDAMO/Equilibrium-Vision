---
name: Equilibrium setup & architecture
description: Run commands, port assignments, known quirks, and encoding conventions for the Equilibrium blockchain project.
---

## Run commands
- API Server: `PORT=8080 pnpm --filter @workspace/api-server run dev` (console workflow, port 8080)
- Explorer: `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/explorer run dev` (webview workflow, port 5000)
- Explorer Vite proxies /api and /ws → localhost:8080, so API Server must be running first.
- Before typechecking api-server: run `pnpm run typecheck:libs` first (builds lib/api-zod dist).

## Port assignments
- API Server: 8080 (console workflow)
- Explorer: 5000 (webview workflow) — was 20087 originally but 20087 is not in Replit's supported port list; changed to 5000 with BASE_PATH=/.

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
