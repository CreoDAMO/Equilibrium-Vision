# Equilibrium

A Rust-based Layer-1 blockchain with **Proof-of-Stationarity** consensus, adaptive difficulty, BFT finality, libp2p P2P networking, a native DEX AMM, staking & slashing, Gossipsub tx propagation, and a full TypeScript node stack with a real-time block explorer and self-custody browser wallet.

---

## What is Proof-of-Stationarity?

Proof-of-Stationarity replaces energy-wasting hashing with a **Lagrangian optimization problem**. Miners compete to find the stationary point of a dynamically generated cost function — a point where the gradient vanishes. Block quality is measured by the **residual** (how close to true stationarity the solution is). Lower residual = better block. This makes mining:

- Computationally lightweight (solvable on a mobile phone)
- Mathematically verifiable in microseconds
- Tunable for difficulty without wasted energy

---

## Repository Layout

```
equilibrium/              # Rust core library + binaries
  src/
    chain_state.rs        # Block and transaction state machine
    stationary_solver.rs  # Lagrangian optimizer (the "mining" engine)
    consensus.rs          # Proof-of-Stationarity block validation
    zk_proof.rs           # ZK proof stubs (Arkworks/Groth16)
    p2p.rs                # libp2p networking layer
    ffi.rs                # C-ABI FFI for Android/iOS integration
    crypto.rs             # SHA-256 / SHA-512 utilities
    wallet.rs             # Ed25519 keypair, address derivation, signing
  testnet/node/main.rs    # Testnet node binary
  src/bin/wallet.rs       # CLI wallet binary

artifacts/
  api-server/             # TypeScript Express node (in-memory chain, auto-miner)
  explorer/               # React + Vite block explorer + browser wallet

lib/
  api-spec/               # OpenAPI 3.1 contract (source of truth)
  api-client-react/       # Generated React Query hooks (Orval)
  api-zod/                # Generated Zod validation schemas (Orval)
  db/                     # Drizzle ORM schema (reserved for persistence layer)

Dockerfile                # Single-image build for the API node
```

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
| POST | `/api/faucet` | Drip 1 000 EQU to any address (1 h cooldown) |
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

- **Create** — generates an Ed25519 keypair locally using `@noble/ed25519` + Web Crypto; keys are never transmitted
- **Import** — restore from a 64-char hex private key
- **Send** — builds and signs a transaction, broadcasts to the mempool
- **Balance** — live balance and nonce from the chain, recent transaction history

Address derivation: `SHA-256(publicKeyHex).slice(0, 40)` — identical to the Rust wallet.

Keys are persisted in browser `localStorage`. For testnet use only.

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

The `equilibrium-core` crate exposes:

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
| Wallet crypto | `@noble/ed25519`, Web Crypto API |
| Monorepo | pnpm workspaces, Node.js 20, TypeScript 5.9 |
| Containerization | Docker (single-image node) |

---

## Future Work

### Consensus & Protocol
- [ ] **ZK proof circuit integration** — wire Groth16 circuits to the stationarity proof so every block carries a verifiable ZK proof of residual quality
- [ ] **Full UTXO model** — replace the ledger balance model with a proper UTXO set for parallel validation

### Wallet
- [ ] **BIP-39 mnemonic generation** — 12/24-word seed phrases instead of raw hex private keys
- [ ] **HD wallet derivation** — BIP-44 path derivation from a master seed
- [ ] **Hardware wallet support** — Ledger transport via WebHID / WebUSB
- [ ] **Multi-sig accounts** — m-of-n Ed25519 multi-signature scheme
- [ ] **Encrypted keystore** — AES-GCM password-protected key storage in localStorage

### Mobile Mining
- [ ] **Android mining app** — Kotlin + JNI calling the Rust FFI; foreground service with battery-aware throttling
- [ ] **iOS mining app** — Swift + Rust via `cargo-swift`; BackgroundTasks API integration
- [ ] **Mining pool protocol** — Stratum-style pool for phones that can't maintain a full node

### Smart Contracts
- [ ] **WASM execution environment** — deterministic WASM runtime for smart contracts (e.g., ink! or custom)
- [ ] **EVM compatibility layer** — optional EVM precompile for Solidity contract migration

### Infrastructure
- [ ] **Full persistence layer** — PostgreSQL-backed chain state replacing the in-memory store (Drizzle schema is already stubbed)
- [ ] **WebSocket subscriptions** — real-time push for new blocks and mempool updates (no more polling)
- [ ] **Multi-region testnet** — geographically distributed seed nodes with public DNS
- [ ] **TypeScript SDK** — `@equilibrium/sdk` npm package wrapping the REST API with typed helpers

---

## License

MIT
