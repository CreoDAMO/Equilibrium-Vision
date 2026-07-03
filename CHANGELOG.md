# Changelog

All notable changes to Equilibrium are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.3.0] — 2026-07-03

### Added

#### API
- **`POST /api/blocks/submit`** — external block submission endpoint. Validates residual against the 1 × 10⁻⁷ threshold (422 on failure), checks `prevHash` matches the current chain tip (409 on stale), drains the mempool into the new block, credits the miner's UTXO, and broadcasts `new_block` + `mempool_update` events over WebSocket. Block is also persisted to Postgres.

#### Android mobile miner
- **`MiningWorker.kt`** — complete OkHttp round-trip: `GET /api/chain/status` to fetch the current tip → JNI `solveBlock()` to run the Proof-of-Stationarity Lagrangian optimizer in Rust → `POST /api/blocks/submit` to submit the solved block.
- **`MiningService.kt`** — passes `KEY_NODE_URL` and `KEY_MINER_ADDRESS` to the worker via `WorkerParameters` so the node URL and miner address are configurable at runtime.

#### Test suite (`@workspace/api-server`)
- **`vitest.config.ts`** — Vitest 4 config with `.js` → `.ts` import alias (required for `node16` module resolution in source files), `forks` pool for clean ESM isolation, and V8 coverage reporting.
- **`src/__tests__/chain.unit.test.ts`** — 40 unit tests covering:
  - `hash256`: determinism, avalanche, double-SHA256 vs single
  - `merkleRoot`: empty list, single element, even pair, odd-length duplication, four-element tree
  - `addressFromSeed`: length, determinism, SHA-256 prefix property
  - `fpEncode`: zero, `Math.floor` (not `Math.round`), threshold value, BN254 field bounds
  - `blockHashToFields`: decimal string output, `blockHashHigh = 0` for 128-bit inputs, `0x` prefix handling, value correctness
  - `generateZkProof` / `verifyZkProof`: valid/invalid residual, G1 point coordinates non-zero, round-trip verification, tampered-residual rejection, wrong `vkHash` rejection, wrong `circuitId` rejection, different-block divergence
  - `ChainState.updateDifficulty`: +20% clamp on fast blocks, −20% clamp on slow blocks, no change at target, 100 000 floor enforcement, empty-chain no-op
- **`src/__tests__/api.integration.test.ts`** — 22 integration tests via Supertest covering every major route group:
  - `GET /api/healthz`
  - `GET /api/chain/status` (shape, hash length, positive difficulty)
  - `GET /api/blocks` (pagination, `limit` param, field shape, page-2 divergence)
  - `GET /api/blocks/:hashOrHeight` (by height, by hash round-trip, 404 unknown hash, 404 beyond tip)
  - `GET /api/mempool`
  - `POST /api/blocks/submit` (400 missing miner / nonce / residual, 422 above threshold, 409 stale prevHash, 201 valid submission reflected in chain height)
  - `GET /api/utxo/:address`
  - `GET /api/network/peers`
  - `GET /api/validators`

### Fixed

- **`@noble/ed25519` v2 → v3 migration** in `artifacts/explorer/src/wallet/crypto.ts`: `ed.utils.randomPrivateKey()` → `ed.utils.randomSecretKey()`, `ed.utils.hexToBytes()` → `ed.etc.hexToBytes()`, all sign/verify calls now use the async API (`getPublicKeyAsync`, `signAsync`) with `Uint8Array` arguments. The v2 surface threw at runtime; v3 is fully operational.
- **Undefined `cs` in UTXO spend route** — `POST /api/utxo/spend` referenced `cs.utxoSet` without defining `const cs = chainState`, unlike every other handler in the file. Added the missing assignment.
- **TypeScript typecheck failures** across all packages — resolved `WebAssembly` namespace (added `"dom"` to `api-server` tsconfig `lib`), `noImplicitReturns` violations in route handlers, `Uint8Array<ArrayBufferLike>` vs `BufferSource` mismatch in `wallet/crypto.ts`, WebHID/WebUSB ambient type gaps in `wallet/ledger.ts`, and React Query `queryKey` generic mismatch in generated hooks. `pnpm run typecheck` now passes clean.
- **Mining stop-safety race** — rapid `stopMining()` → `startMining()` calls could produce duplicate concurrent `setTimeout` cycles. Fixed with a generation counter: `startMining()` increments the generation, each cycle checks its captured generation against the current one in the `finally` block before rescheduling, `stopMining()` bumps the counter and clears the timer.

### Changed

- **`chain/zkproof.ts`** — `pi_a` and `pi_c` are now real BN254 G1 elliptic-curve points computed via scalar multiplication using `@noble/curves/bn254`, not deterministic SHA-256 derivations. `pi_b` remains a G2 placeholder pending full Groth16 pairing verification.
- **`chain/zk-encoding.ts`** — extracted as the single canonical source for BN254 field encoding. Both the TypeScript prover (`zkproof.ts`) and the Rust `consensus-api` bridge import `fpEncode` and `blockHashToFields` from here, guaranteeing bit-identical public inputs regardless of which prover ran.
- **Postgres persistence** fully wired into `api-server` via Drizzle ORM (`lib/db/`). `initChain()` restores the full chain from the database on startup and falls back to the 25-block genesis chain when the database is empty or unavailable. Every mined block (auto-miner and external submit) is persisted via `persistBlock`.

### Documentation

- `README.md` — Known Issues table all resolved, Remaining Work section updated to reflect completion, ZK proof section rewritten to describe real curve operations accurately, stale `TODO.md` references removed, `lib/db/` description corrected.
- `TODO.md` — replaced the stale P0–P4 open-checklist (including raw AI session notes) with a clean resolved-items table.

---

## [0.2.0] — prior to 2026-07-03

Initial public testnet feature set:

- Proof-of-Stationarity consensus with Lagrangian optimizer (`equilibrium/` Rust crate)
- TypeScript API node (`artifacts/api-server`) with in-memory `ChainState`, 25-block genesis chain, 15-second auto-miner
- Block explorer (`artifacts/explorer`) — Dashboard, Blocks, Transactions, Addresses, Mempool, Network pages
- Browser wallet — Ed25519 keypair generation, private-key import, transaction signing and broadcast
- Adaptive difficulty (`updateDifficulty` ±20% per block, 100 000 floor)
- DEX AMM — two genesis pools (`EQU-WBTC`, `EQU-USDC`), constant-product formula, swap/liquidity/quote routes
- Staking — bond/unbond with 10-block waiting period, proportional block reward distribution
- Validators and slashing — `double_sign` (5%), `downtime` (1%), `invalid_block` (1%); finality gadget
- UTXO set — coinbase UTXOs on every block, coin selection, spend validation
- WASM smart-contract VM — deploy and call endpoints, Node.js `WebAssembly` runtime
- libp2p P2P networking in the Rust crate — peer discovery, gossip, block/tx propagation
- ZK proof stub — Groth16-shaped output with BN254 field elements; upgraded to real curve ops in 0.3.0
- OpenMetrics `/metrics` endpoint (Prometheus / Grafana compatible)
- Drizzle ORM schema for `blocks`, `transactions`, `validators` tables; fully wired in 0.3.0
- Android mining skeleton — `MiningService.kt`, `MiningWorker.kt`; full round-trip wired in 0.3.0
- OpenAPI 3.1 contract, Orval codegen, generated React Query hooks and Zod schemas
- Docker single-image build for the API node

---

## [0.1.0] — initial commit

Project scaffold: Rust crate, TypeScript monorepo, pnpm workspaces, Vite/React explorer skeleton, wallet crypto primitives.
