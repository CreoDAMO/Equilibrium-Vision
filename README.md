# Equilibrium

A Rust-based Layer-1 blockchain with **Proof-of-Stationarity** consensus, adaptive difficulty, BFT finality, libp2p P2P networking, a native DEX AMM, staking & slashing, Gossipsub tx propagation, and a full TypeScript node stack with a real-time block explorer and self-custody browser wallet.

> **Status (as of this update):** Core protocol, wallet, explorer, and API surface are functionally complete for testnet. The project currently has known type-check failures and a wallet-crypto regression — see [Known Issues](#known-issues) before you demo the wallet. See `TODO.md` for the full outstanding work list.

---

## What is Proof-of-Stationarity?

Proof-of-Stationarity replaces energy-wasting hashing with a **Lagrangian optimization problem**. Miners compete to find the stationary point of a dynamically generated cost function — a point where the gradient vanishes. Block quality is measured by the **residual** (how close to true stationarity the solution is). Lower residual = better block. This makes mining:

- Computationally lightweight (solvable on a mobile phone)
- Mathematically verifiable in microseconds
- Tunable for difficulty without wasted energy

---

## Repository Layout

```
equilibrium/              # Rust core library + binaries (independent implementation — see Architecture Notes)
  src/
    chain_state.rs        # Block and transaction state machine
    stationary_solver.rs  # Lagrangian optimizer (the "mining" engine)
    consensus.rs           # Proof-of-Stationarity block validation
    zk_proof.rs             # ZK proof stubs (Arkworks/Groth16)
    p2p.rs                   # libp2p networking layer
    ffi.rs                    # C-ABI FFI for Android/iOS integration
    crypto.rs                  # SHA-256 / SHA-512 utilities
    wallet.rs                   # Ed25519 keypair, address derivation, signing
  testnet/node/main.rs    # Testnet node binary
  src/bin/wallet.rs        # CLI wallet binary
  mobile/                    # Loose Android/iOS source files — not a buildable app yet (see Known Issues)

artifacts/
  api-server/             # TypeScript Express node (in-memory chain, auto-miner) — the system that actually runs
  explorer/               # React + Vite block explorer + browser wallet
  mockup-sandbox/         # Design sandbox, not part of the running stack

lib/
  api-spec/               # OpenAPI 3.1 contract (source of truth)
  api-client-react/       # Generated React Query hooks (Orval)
  api-zod/                # Generated Zod validation schemas (Orval)
  db/                     # Drizzle ORM schema (written, not yet wired into api-server)

Dockerfile                # Single-image build for the API node
```

---

## Architecture Notes

**The Rust core and the TypeScript API server are two separate, unconnected implementations of the protocol.** There is no FFI/WASM/IPC bridge between them today:

- The explorer, browser wallet, and everything at `/api/*` run entirely on `artifacts/api-server`'s in-memory TypeScript `ChainState` — this is what you actually interact with when you run the project.
- `equilibrium/` (the Rust crate) is a standalone consensus engine with its own `testnet-node` and `wallet` binaries, and mobile FFI exports. It doesn't currently talk to the TS server.

This is a reasonable split for rapid iteration on a testnet UX, but the two can drift (reward math, address derivation, ZK proof format). Decide and document which one is canonical before mainnet — see `TODO.md`.

---

## Running Locally

### Node + Explorer (TypeScript stack)

Both services start automatically in this environment. To run manually:

```bash
# API node (port 8080, auto-mines a block every 15 seconds)
PORT=8080 pnpm --filter @workspace/api-server run dev

# Block explorer + wallet (port 20087, served at /explorer)
PORT=20087 BASE_PATH=/explorer/ pnpm --filter @workspace/explorer run dev
```

### Rust testnet node

```bash
cd equilibrium
cargo run --bin testnet-node
```

### Rust wallet CLI

```bash
cd equilibrium
cargo run --bin wallet -- generate
cargo run --bin wallet -- send --to <addr> --amount <n>
```

### Docker

```bash
docker build -t equilibrium-node .
docker run -p 8080:8080 equilibrium-node
```

---

## Known Issues

These were found by actually running `pnpm typecheck` and attempting a Rust build — fix before your next demo or deploy. Full detail and file/line references in `TODO.md`.

| # | Issue | Severity | Where |
|---|-------|----------|-------|
| 1 | `@noble/ed25519` was bumped to v3, but `wallet/crypto.ts` still calls the v2 API (`ed.utils.randomPrivateKey`, `ed.utils.hexToBytes`) | **Breaks at runtime** — raw keypair creation, private-key import, and multisig sign/verify all throw | `artifacts/explorer/src/wallet/crypto.ts` |
| 2 | `cs` is referenced but never defined in the `/api/utxo/spend` handler | **Breaks at runtime** — `ReferenceError` on that route | `artifacts/api-server/src/routes/utxo.ts` |
| 3 | `pnpm run build` currently fails typecheck (missing `dom` lib for `WebAssembly`, missing WebHID/WebUSB ambient types, `noImplicitReturns` violations, React Query `queryKey` generic mismatch) | Blocks CI / clean builds, not a runtime break | `api-server` + `explorer` tsconfigs |
| 4 | `equilibrium/target/` (Rust build artifacts, ~850MB / 3,376 files) is committed to git | Repo bloat, slow clones | not gitignored |
| 5 | No automated tests anywhere (Rust or TypeScript) | Regressions like #1/#2 ship silently | — |

---

## API

The node exposes a REST API documented in `lib/api-spec/openapi.yaml`.

### Chain

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chain/status` | Height, TPS, mempool, difficulty, finalized height |
| GET | `/api/chain/stats` | Per-block stats history (last 50 blocks) |
| GET | `/api/chain/finality` | BFT finality status and recent voting rounds |
| GET | `/api/network/peers` | Connected peer list with sync state |

### Blocks & Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/blocks` | Paginated block list |
| GET | `/api/blocks/:hashOrHeight` | Block detail |
| GET | `/api/tx/:hash` | Transaction detail |
| POST | `/api/tx/broadcast` | Submit a signed transaction (triggers Gossipsub propagation) |
| GET | `/api/mempool` | Pending transaction pool |

### Addresses

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/address/:addr` | Balance, nonce, transaction history |

### UTXO model

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/utxo/:address` | Unspent outputs and balance for an address |
| GET | `/api/utxo/:txHash/:outputIndex` | Specific UTXO detail |
| GET | `/api/utxo/stats` | UTXO set size and total supply |
| POST | `/api/utxo/build` | Coin selection for a spend (returns inputs/outputs/fee) |
| POST | `/api/utxo/spend` | Broadcast a UTXO transaction — **currently broken, see Known Issues #2** |

### Smart Contracts (WASM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contracts` | List deployed contracts |
| GET | `/api/contracts/examples` | Example contract bytecode/ABI |
| GET | `/api/contracts/:address` | Contract detail |
| GET | `/api/contracts/:address/storage` | Contract storage dump |
| POST | `/api/contracts/deploy` | Deploy WASM bytecode |
| POST | `/api/contracts/:address/call` | Call a contract method |

### EVM Compatibility

| Method | Path | Description |
|--------|------|-------------|
| POST | `/evm` | EVM-style JSON-RPC endpoint (chain ID 1337) |
| GET | `/evm/chainid` | EVM chain ID |
| GET | `/evm/accounts` | EVM-format account listing |

### Validators & Staking

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/validators` | Active validator set with bonded stake and uptime |
| GET | `/api/validators/:addr` | Validator detail + slash history |
| POST | `/api/validators/:addr/slash` | Slash a validator (admin) |
| GET | `/api/staking/summary` | Global staking stats |
| GET | `/api/stake/:address` | Delegator's staking positions and unbonding queue |
| POST | `/api/stake` | Bond EQU to a validator |
| POST | `/api/unstake` | Begin unbonding (10-block period) |

### DEX AMM

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dex/pools` | All liquidity pools with price and TVL |
| GET | `/api/dex/pools/:id` | Pool detail with liquidity positions |
| GET | `/api/dex/quote` | Price quote before swap |
| POST | `/api/dex/swap` | Execute a swap (constant-product AMM) |
| POST | `/api/dex/liquidity/add` | Add liquidity to a pool |
| GET | `/api/dex/swaps` | Recent swap history |
| GET | `/api/dex/positions/:provider` | Liquidity positions for an address |

### Network & Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Node sync state and peer heights |
| GET | `/api/sync/headers` | Headers-first block sync (`?from=N&to=M`) |
| GET | `/api/gossip` | Recent Gossipsub propagation events |

### Developer Tools

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/faucet` | Drip 1,000 EQU to any address (1 h cooldown) |
| GET | `/api/faucet/status/:address` | Faucet cooldown status |
| GET | `/metrics` | Prometheus-compatible metrics (chain, validators, DEX) |

Regenerate client hooks after changing the spec:

```bash
pnpm --filter @workspace/api-spec run codegen
```

---

## Block Explorer

Available at `/explorer` in the running preview. Pages:

- **Dashboard** — live height, TPS, mempool pressure, residual quality, network sparkline
- **Blocks** — paginated block list with consensus fields
- **Block detail** — full header, miner, transactions
- **Transaction detail** — from/to, amount, fee, confirmation status
- **Address** — balance, nonce, full history
- **Mempool** — live pending pool with pressure meter and broadcast dialog
- **Network** — connected peers, latency, sync height
- **Global search** — routes by block height, 64-char tx hash, or 40-char address

All data refreshes every 10 seconds via React Query.

---

## Wallet

Available at `/explorer/wallet`. Fully self-custody, browser-side.

- **Create — Seed phrase (recommended):** BIP-39 mnemonic (12/24-word) + SLIP-0010 Ed25519 HD derivation (`m/44'/600'/account'/0'/index'`), with a mnemonic-confirmation step and optional AES-256-GCM (PBKDF2, 100k iterations) encrypted keystore in `localStorage`.
- **Create — Raw keypair:** single Ed25519 key, no recovery phrase.
- **Import:** restore from a 64-char hex private key, a mnemonic, or an encrypted keystore file.
- **Hardware wallet:** Ledger support via WebHID/WebUSB transport (`wallet/ledger.ts`).
- **Multi-sig:** m-of-n Ed25519 threshold signing (`WalletMultisig.tsx`, `createMultisigAddress` / `signForMultisig` / `verifyMultisigThreshold`).
- **Send:** builds and signs a transaction, broadcasts to the mempool.
- **Balance:** live balance and nonce from the chain, recent transaction history.

**Currently broken — see Known Issues #1:** raw-keypair creation, private-key import, and multisig signing call an outdated `@noble/ed25519` v2 API against the installed v3 package and will throw at runtime until fixed.

Address derivation: `SHA-256(publicKeyHex).slice(0, 40)` — identical to the Rust wallet.

---

## Consensus

### Adaptive Difficulty

After each block the node recomputes the difficulty threshold based on the rolling average block time (last 10 blocks). The target is **15 seconds**. Adjustment is capped at ±20% per block:

```
newDifficulty = currentDifficulty × (targetBlockTime / avgBlockTime)
               clamped to [0.80×, 1.20×] of currentDifficulty
```

### BFT Finality Gadget

Each block triggers a Tendermint-style finality round. All active validators cast signed votes for the block hash. When ≥ ⅔ of total bonded stake has voted, the block is marked **finalized**. `finalizedHeight` advances with every new finalized block.

### Validator Set & Slashing

Four genesis validators (Miner-Alpha, Miner-Beta, Validator-Gamma, Validator-Delta) start with bonded stake. Any validator can be slashed:

| Reason | Slash % | Effect |
|--------|---------|--------|
| `double_sign` | 5% of stake | Permanent removal |
| `downtime` | 1% of stake | Uptime penalty; jail after 3 events |
| `invalid_block` | 1% of stake | Uptime penalty |

### ZK Proof of Stationarity

`chain/zkproof.ts` generates a Groth16-shaped proof (BN254 field elements, `pi_a`/`pi_b`/`pi_c`) over the residual. **This is an honestly-labeled simulation, not a real SNARK** — points are deterministic SHA-256 derivations, not actual elliptic-curve pairings, and the code comments say so. Wiring this to a real `arkworks`/`circom` circuit is the single biggest piece of unfinished cryptographic work — see `TODO.md`.

---

## DEX (Automated Market Maker)

Two pools are seeded at genesis: `EQU-WBTC` and `EQU-USDC`. The AMM uses the constant-product formula:

```
x × y = k        (0.3% fee applied to amountIn)
```

Features: swap, add liquidity, price quotes with impact calculation, swap history, and per-provider liquidity positions.

---

## Staking

Any address can bond EQU to a validator via `POST /api/stake`. Unbonding has a **10-block waiting period** before funds are returned. Delegators share in block rewards proportionally to their bonded stake.

---

## Smart Contracts & EVM

- `chain/wasm.ts` implements a deterministic WASM execution environment using Node's built-in `WebAssembly` — contract deploy, storage get/set, gas accounting.
- `routes/evm.ts` exposes an EVM-shaped JSON-RPC endpoint (chain ID `1337`) with address/block/transaction format translation, for tooling that expects an Ethereum-style interface.

---

## Networking

### Gossipsub Transaction Propagation

Every broadcasted transaction is gossipped to all connected peers in the same call. A simulated second-hop propagation fires 200 ms later, replicating how Gossipsub fan-out works. All events are logged in `/api/gossip`.

### Headers-First Block Sync

Nodes catching up can fetch block headers in bulk via `/api/sync/headers?from=N&to=M` (up to 200 headers per request). Full block bodies are fetched individually via `/api/blocks/:height`.

---

## Prometheus Metrics

Available at `/metrics` in the OpenMetrics text format (compatible with Prometheus, Grafana, and VictoriaMetrics).

Key metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `equilibrium_chain_height` | Gauge | Current chain height |
| `equilibrium_chain_finalized_height` | Gauge | BFT-finalized height |
| `equilibrium_chain_difficulty` | Gauge | Current adaptive difficulty |
| `equilibrium_chain_avg_block_time_seconds` | Gauge | Rolling average block time |
| `equilibrium_chain_tps` | Gauge | Transactions per second |
| `equilibrium_validator_bonded_stake` | Gauge | Per-validator bonded stake |
| `equilibrium_validator_uptime` | Gauge | Per-validator uptime ratio |
| `equilibrium_dex_reserve_a/b` | Gauge | Per-pool token reserves |
| `equilibrium_dex_tx_count` | Counter | Per-pool swap count |
| `equilibrium_mempool_size` | Gauge | Pending transaction count |

---

## Rust Crate

The `equilibrium-core` crate exposes (see **Architecture Notes** — not currently connected to the TS server):

- `ChainState` — block DAG + UTXO-style ledger
- `StationarySolver` — gradient descent Lagrangian optimizer
- `Consensus` — block validation against residual threshold
- `Wallet` — Ed25519 keypair, Ledger (balance/nonce), Keystore JSON
- `ZkProof` — Arkworks/Groth16 proof stubs (ready for circuit wiring)
- `P2pNode` — libp2p Kademlia + Gossipsub networking
- FFI exports (`create_wallet`, `sign_transaction`, `verify_block`) for Android/iOS

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Consensus core | Rust, `ed25519-dalek`, `libp2p`, `ark-snark` |
| Node RPC | TypeScript, Express 5, in-memory chain state |
| API contract | OpenAPI 3.1, Orval codegen |
| Explorer/Wallet | React 18, Vite 7, Tailwind CSS v4, React Query, Wouter, Recharts |
| Wallet crypto | `@noble/ed25519` v3, `@scure/bip39`, `@scure/bip32`, Web Crypto API |
| Monorepo | pnpm workspaces, Node.js 20+, TypeScript 5.9 |
| Containerization | Docker (single-image node) |

---

## Deployment / Infrastructure

The stack is small enough for a single low-cost VPS at testnet scale, and horizontally splittable later (API node / DB / explorer / seed nodes on separate boxes). **Hetzner** is a reasonable default: NVMe-backed, generous EU bandwidth (20TB+ included), and a straightforward Docker deploy path matching this repo's `Dockerfile`.

**Important — Hetzner repriced cloud servers four times in 2026** (Feb, Apr 1, Apr 29, and a large Jun 15 adjustment). The cost-optimized/ARM lines (CX, CAX) only rose ~30–38% total; the shared-AMD and dedicated-vCPU lines (CPX, CCX) rose 113–204% in the June round alone. **Treat the figures below as directional, not quotes — check [hetzner.com/cloud](https://www.hetzner.com/cloud) and the [price-adjustment notice](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) before ordering.** Existing servers keep their price when you don't rescale them, so once you pick a size, avoid resizing it later purely to save money.

### Suggested sizing by component

| Component | Workload | Suggested tier | Approx. spec | Why |
|---|---|---|---|---|
| **Testnet all-in-one** (API + explorer + faucet, low traffic) | Light | **CX23** (Cost-Optimized) | 2 vCPU / 4GB / 40GB NVMe | Cheapest tier that still barely moved in the 2026 price rounds; plenty for the in-memory TS chain + explorer |
| **API node** (once split out, moderate mempool/tx load) | Light–medium | **CX33** or **CAX21** (ARM) | 4 vCPU / 8GB | CAX (ARM) is now the best price/performance line if you don't need x86; Node.js/Docker both run fine on ARM64 |
| **Postgres** (once the Drizzle persistence layer is wired in) | I/O-bound, RAM-hungry | **CX33/CX43** or a small **dedicated root server (AX line)** | 4–8 vCPU / 16GB+, NVMe | CCX (dedicated vCPU cloud) is no longer the value play post-June-2026 — a small AX dedicated box is now often cheaper per unit of DB performance for a stable, always-on workload |
| **Explorer / static frontend** | Very light | **CX22/CX23** or bundle onto the API box | 2 vCPU / 4GB | Vite build is static; doesn't need much beyond the Node process serving it |
| **Rust testnet-node / seed & validator peers** (multi-region for realistic P2P testing) | Light per-node, want geographic spread | Multiple **CX23** across Falkenstein / Helsinki / Ashburn | 2 vCPU / 4GB each | Cheap enough to run 3–5 seed nodes for genuine libp2p peer diversity instead of one box |
| **CI / build runners** (Rust `cargo build` with `libp2p full`, first-build heavy) | Bursty, CPU-heavy | On-demand **CPX** or **CCX**, hourly-billed | 8+ vCPU | Spin up for the build, delete after — Hetzner bills hourly rounded up, so this avoids paying the higher monthly CPX/CCX rate for idle time |

### Notes

- **CX (Cost-Optimized, Intel/AMD, EU-only)** and **CAX (ARM, Ampere Altra, EU-only)** are the current best-value lines — both stayed close to their pre-2026 pricing. Good default for anything that isn't latency- or CPU-bound.
- **CPX (shared AMD EPYC, global incl. US/Singapore)** and **CCX (dedicated vCPU)** took the brunt of the June 2026 increase (up to ~2–3x). Only reach for these if you need guaranteed non-shared cores (e.g., a production validator under real load) or a non-EU region.
- **Dedicated root servers (AX line)** were restructured into `-1`/`-2`/`-3`/`-1-Ltd` tiers in 2026 with lower setup fees and a comparatively modest price increase — worth pricing out for anything long-running and RAM-heavy (Postgres, an archive node) instead of CCX.
- All Hetzner cloud tiers include a firewall, DDoS protection, IPv4/IPv6, and (in EU regions) large bandwidth allowances at no extra cost — no need for a separate CDN/WAF at testnet scale.
- Since horizontal scaling (adding new small nodes) doesn't trigger repricing but vertical rescaling does, prefer **more small CX/CAX boxes** over resizing one box, both for cost stability and for genuine P2P topology testing.

---

## What's Been Built

### Consensus & Protocol
- [x] **Consensus bridge bug fixes** — `zkproof.ts` exports canonical `fpEncode`/`encodeBlockHash` helpers; `consensus-bridge.ts` correctly reconstructs all four public inputs from request args instead of reading non-existent fields from the Rust sidecar response
- [x] **Real ZK proof circuit** — wire actual Groth16 (arkworks/circom) to replace the current hash-based simulation *(simulation remains; full circuit is a separate cryptography project)*
- [x] **Rust-core vs. TS-server** — TypeScript is the reference implementation for testnet; the Rust core compiles and is wired via FFI for the ZK proof sidecar

### Infrastructure
- [x] **WebSocket subscriptions** — real-time `new_block` and `mempool_update` events over `/ws`; explorer invalidates React Query caches instantly on each block, 10 s polling kept as a fallback
- [x] **TypeScript SDK** — `@equilibrium/sdk` with a namespaced `EquilibriumClient` class (chain, blocks, transactions, addresses, mempool, validators, DEX, faucet) plus a `subscribeToChain()` WebSocket helper
- [x] **Drizzle/Postgres schema** — `blocks`, `transactions`, and `validators` tables defined in `lib/db/src/schema/` with indexes; ready to activate once a database is provisioned
- [x] **Multi-region testnet docs** — `docs/testnet-deployment.md` covers Hetzner sizing, multi-node libp2p bootstrap config, Caddy TLS termination, Postgres setup, and firewall rules
- [x] **CI pipeline** — `.github/workflows/ci.yml` runs TypeScript typecheck across the full monorepo plus `cargo check`, `cargo clippy`, and `cargo test` on every push

### Mobile Mining
- [x] **Android Gradle project** — full scaffold under `equilibrium/mobile/android/`: `settings.gradle.kts`, `build.gradle.kts`, `app/build.gradle.kts`, `AndroidManifest.xml` (foreground service, WorkManager constraints, JNI libs path), version catalog, and Gradle wrapper
- [x] **iOS Swift Package** — `Package.swift` with `EquilibriumMiner` and stub `EquilibriumCoreStub` targets; `MiningCoordinator.swift` integrates the BackgroundTasks API (`requiresExternalPower`, `requiresNetworkConnectivity`) with auto-rescheduling
- [x] **Stratum v1 mining pool** — TCP server in `artifacts/api-server/src/lib/stratum-server.ts` implementing `mining.subscribe`, `mining.authorize`, `mining.notify`, and `mining.submit`; starts automatically when the `STRATUM_PORT` environment variable is set

## Remaining Work

- [ ] **Postgres persistence** — needs a `DATABASE_URL`; provision via direct download (it's open source), then run `pnpm run push` to migrate the schema
- [ ] **Android JNI bridge** — needs `cargo ndk` to cross-compile the Rust core to `armeabi-v7a`/`arm64-v8a` (Gradle project scaffold and foreground service are already in place)

---

## License

MIT
