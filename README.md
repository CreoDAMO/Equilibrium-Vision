# Equilibrium

A Rust-based Layer-1 blockchain with **Proof-of-Stationarity** consensus, mobile mining support, ZK proofs, libp2p P2P networking, and a full TypeScript node stack with a real-time block explorer and self-custody browser wallet.

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
```

---

## Running Locally

### Node + Explorer (TypeScript stack)

Both services start automatically in this environment. To run manually:

```bash
# API node (port 5000, auto-mines a block every 15 seconds)
pnpm --filter @workspace/api-server run dev

# Block explorer + wallet (port 20087, served at /explorer)
pnpm --filter @workspace/explorer run dev
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

### Cross-compile for mobile

```bash
# Android (requires cargo-ndk)
cargo ndk --target aarch64-linux-android build --release

# iOS
cargo build --target aarch64-apple-ios --release
```

---

## API

The node exposes a REST API documented in `lib/api-spec/openapi.yaml`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chain/status` | Height, TPS, mempool size, last residual |
| GET | `/api/chain/stats` | Per-block stats history for charting |
| GET | `/api/network/peers` | Connected peer list |
| GET | `/api/blocks` | Paginated block list |
| GET | `/api/blocks/:hashOrHeight` | Block detail |
| GET | `/api/tx/:hash` | Transaction detail |
| POST | `/api/tx/broadcast` | Submit a signed transaction |
| GET | `/api/address/:addr` | Balance, nonce, transaction history |
| GET | `/api/mempool` | Pending transaction pool |

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
| Monorepo | pnpm workspaces, Node.js 24, TypeScript 5.9 |

---

## Future Features

### Consensus & Protocol
- [ ] **ZK proof circuit integration** — wire Groth16 circuits to the stationarity proof so every block carries a verifiable ZK proof of residual quality
- [ ] **Adaptive difficulty** — dynamically adjust the residual threshold based on rolling block-time average (target: 15 s)
- [ ] **Validator set & slashing** — define a bonded validator set with economic penalties for invalid blocks
- [ ] **Finality gadget** — BFT-style finality layer on top of the longest-chain rule (e.g., Tendermint-style voting round)
- [ ] **Full UTXO model** — replace the ledger balance model with a proper UTXO set for parallel validation

### Networking
- [ ] **Persistent peer discovery** — Kademlia DHT bootstrap with hardcoded seed nodes
- [ ] **Block sync protocol** — efficient catch-up for nodes that join mid-chain (headers-first sync)
- [ ] **Transaction gossip** — Gossipsub topic for mempool propagation between peers
- [ ] **NAT traversal** — libp2p circuit relay for mobile nodes behind NAT

### Mobile Mining
- [ ] **Android mining app** — Kotlin + JNI calling the Rust FFI; foreground service with battery-aware throttling
- [ ] **iOS mining app** — Swift + Rust via `cargo-swift`; BackgroundTasks API integration
- [ ] **Mining pool protocol** — Stratum-style pool for phones that can't maintain a full node

### Wallet & Accounts
- [ ] **BIP-39 mnemonic generation** — 12/24-word seed phrases instead of raw hex private keys
- [ ] **HD wallet derivation** — BIP-44 path derivation from a master seed
- [ ] **Hardware wallet support** — Ledger transport via WebHID / WebUSB
- [ ] **Multi-sig accounts** — m-of-n Ed25519 multi-signature scheme
- [ ] **Encrypted keystore** — AES-GCM password-protected key storage in localStorage

### Smart Contracts & DeFi
- [ ] **WASM execution environment** — deterministic WASM runtime for smart contracts (e.g., ink! or custom)
- [ ] **EVM compatibility layer** — optional EVM precompile for Solidity contract migration
- [ ] **Native DEX** — on-chain automated market maker for EQU coin pairs
- [ ] **Staking contract** — lock EQU to participate in validator set, earn block rewards

### Developer Experience
- [ ] **Full persistence layer** — PostgreSQL-backed chain state replacing the in-memory store (Drizzle schema is already stubbed)
- [ ] **WebSocket subscriptions** — real-time push for new blocks and mempool updates (no more polling)
- [ ] **Faucet endpoint** — `POST /api/faucet` drips testnet EQU to any address
- [ ] **Chain snapshot / restore** — export and import chain state for fast testnet resets
- [ ] **TypeScript SDK** — `@equilibrium/sdk` npm package wrapping the REST API with typed helpers

### Infrastructure
- [ ] **Docker / OCI image** — single-image node for cloud deployment
- [ ] **Prometheus metrics** — `/metrics` endpoint for chain health observability
- [ ] **Multi-region testnet** — geographically distributed seed nodes with public DNS

---

## License

MIT
