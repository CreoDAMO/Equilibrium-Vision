# Equilibrium — Status

All previously tracked issues and planned testnet features are complete.
See `README.md` for full details.

## Resolved

| # | Item | Resolution |
|---|------|-----------|
| P0-1 | `@noble/ed25519` v2 API in `wallet/crypto.ts` | Migrated to v3 (`randomSecretKey`, `etc.hexToBytes`, async API) |
| P0-2 | Undefined `cs` variable in UTXO spend route | `const cs = chainState` added to every handler |
| P0-3 | `pnpm run typecheck` failures across all packages | Clean — WebAssembly lib, `noImplicitReturns`, React Query types, WebHID stubs all fixed |
| P0-4 | `equilibrium/target/` committed to git | Gitignored; build artifacts no longer tracked |
| P0-5 | No automated tests | 62 tests passing (`pnpm --filter @workspace/api-server test`) |
| P1-1 | Mining stop-safety race (duplicate timer cycles) | Generation-counter pattern implemented in `chain/index.ts` |
| P1-2 | ZK public-input encoding divergence | `chain/zk-encoding.ts` is now the single source of truth for `fpEncode` and `blockHashToFields`; both the TS prover and Rust bridge import from it |
| P1-3 | Real BN254 curve operations | `chain/zkproof.ts` uses `@noble/curves/bn254` for genuine G1 scalar multiplication |
| P2-1 | Postgres persistence | Drizzle ORM schema wired into `api-server`; blocks persisted on every mine and external submit |
| P2-2 | External block submission endpoint | `POST /api/blocks/submit` validates residual, prevHash, and miner; broadcasts via WebSocket |
| P2-3 | Android mining worker full round-trip | `MiningWorker.kt` does GET `/api/chain/status` → JNI `solveBlock()` → POST `/api/blocks/submit` |
