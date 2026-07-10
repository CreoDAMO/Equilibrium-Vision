# Equilibrium

A Rust-based Layer-1 blockchain with **Proof-of-Stationarity** consensus, adaptive difficulty, BFT finality, libp2p P2P networking, a native DEX AMM, staking & slashing, Gossipsub tx propagation, WASM smart contracts, a Stratum v1 mining pool, and a full TypeScript node stack with a real-time block explorer and self-custody browser wallet.

> **Status (July 10, 2026):** Mainnet-readiness hardening complete on Replit. **262 tests (31 Rust + 231 TypeScript across 7 test files)**. All security, UI, and infrastructure-preparation tasks are finished. Remote load test: 149 TPS sustained, p95 70ms, 9,009/9,009 txs accepted. Android APK CI pipeline live, Grafana monitoring stack ready. **`variational-ai` Rust crate shipped** — deterministic NTK/MLP/logistic solvers, CLI verification binary, TypeScript bridge, and SHA-256 determinism harness. **ModelRegistry + Arbitrage + CrossChainRelay WASM contracts deployed and live** — permissionless optimistic-oracle lifecycle, on-chain challenge/slash, Bellman-Ford arbitrage detection, and a federated m-of-n cross-chain attestation protocol with bonded relayers and a challenge window. See `LIMITATIONS.md` for known design constraints.

---

## What is Proof-of-Stationarity?

Proof-of-Stationarity replaces energy-wasting hashing with a **Lagrangian optimization problem**. Miners compete to find the stationary point of a dynamically generated cost function — a point where the gradient vanishes. Block quality is measured by the **residual** (how close to true stationarity the solution is). Lower residual = better block. This makes mining:

- Computationally lightweight (solvable on a mobile phone)
- Mathematically verifiable in microseconds
- Tunable for difficulty without wasted energy

---

## Repository Layout

```
variational-ai/           # AI solver crate (Rust)
  Cargo.toml              # Three binaries: variational-ai, variational-ai-cli, variational-ai-harness
  .cargo/config.toml      # Determinism flags: target-cpu=generic, -C target-feature=-fma
  src/
    lib.rs                # Module declarations
    action.rs             # Action trait (evaluate, gradient, hessian_vec_prod)
    deterministic.rs      # f64 helpers + i64 fixed-point arithmetic (FIXED_SCALE = 1e12)
    logistic.rs           # LogisticAction — binary logistic regression (Newton-CG)
    mlp.rs                # MlpAction — two-layer ReLU MLP (L-BFGS)
    ntk.rs                # NtkAction, solve_ntk (CG), compute_empirical_ntk_mlp
    solver.rs             # StationarySolver (Newton-CG), LbfgsSolver (two-loop L-BFGS)
    mnist.rs              # load_synthetic_mnist() + load_real_mnist() (IDX reader)
    benchmarks.rs         # run_logistic_variational, run_mlp_variational, run_ntk_benchmark
    jni_bridge.rs         # JNI exports for Android (feature-gated: jni-bridge)
    main.rs               # Benchmark runner — tries real MNIST, falls back to synthetic
    bin/
      cli.rs              # variational-ai-cli: stdin JSON → NTK residual verify → stdout JSON
      harness.rs          # variational-ai-harness: SHA-256 determinism conformance harness

equilibrium/              # Rust core library + binaries
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
  mobile/android/            # Android Gradle project (Kotlin + JNI)

artifacts/
  api-server/             # TypeScript Express node (in-memory chain, auto-miner)
  explorer/               # React + Vite block explorer + browser wallet
  mockup-sandbox/         # Design sandbox, not part of the running stack

lib/
  api-spec/               # OpenAPI 3.1 contract (source of truth)
  api-client-react/       # Generated React Query hooks (Orval)
  api-zod/                # Generated Zod validation schemas (Orval)
  db/                     # Drizzle ORM schema

scripts/
  start-postgres.sh              # Idempotent DB bootstrap (role + schema + grants)
  generate-android-keystore.sh   # keytool-first PKCS12 keystore generation
  load-test.js                   # k6 load test (50 VUs, real Ed25519 signed txs)

docs/
  grafana/                 # Prometheus config + Grafana dashboards + docker-compose
  mobile-apk-release.md    # Android APK signing and sideload distribution guide
  zk-circuit.md            # Groth16 circuit specification
  incentive-model.md       # Miner incentive model analysis
  testnet-deployment.md    # Node deployment guide

.github/workflows/
  ci.yml                   # Typecheck + TypeScript tests + Rust tests on every push
android-apk-ci.yml          # Copy this to .github/workflows/ to activate APK CI
```

---

## Architecture Notes

The Rust core and the TypeScript API server are two separate, parallel implementations of the protocol. There is no FFI/WASM/IPC bridge between them:

- The explorer, browser wallet, and everything at `/api/*` run entirely on `artifacts/api-server`'s TypeScript `ChainState` + Postgres — this is what you interact with when you run the project.
- `equilibrium/` (the Rust crate) is a standalone consensus engine with its own `testnet-node` and `wallet` binaries, and mobile FFI exports. It doesn't talk to the TS server.

This is intentional: the TypeScript stack is the live testnet (full explorer, wallet, REST API, Postgres persistence), while the Rust crate is the reference consensus engine and mobile SDK. Address derivation (`SHA-256(pubkeyHex).slice(0,40)`) and ZK public-input encoding (`fpEncode`, `blockHashToFields`) are kept in sync across both.

---

## Running Locally

### Node + Explorer (TypeScript stack)

Both services start automatically in this environment via the configured workflows. To run manually:

```bash
# API node (port 8080, auto-mines a block every 15 seconds)
DATABASE_URL=postgresql://runner@127.0.0.1:5432/equilibrium PORT=8080 \
  pnpm --filter @workspace/api-server run dev

# Block explorer + wallet (port 5000)
PORT=5000 BASE_PATH=/ pnpm --filter @workspace/explorer run dev
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

### After a container reset

```bash
# 1. Reinstall Node dependencies (node_modules are not persisted)
pnpm install

# 2. Start workflows in order: Postgres → API Server → Explorer
# The Postgres workflow is idempotent — safe to run again anytime.
# If workflows don't start automatically, run:
bash scripts/start-postgres.sh
```

---

## API

The node exposes a REST API documented in `lib/api-spec/openapi.yaml`.

Regenerate client hooks after changing the spec:

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Chain

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chain/status` | Height, TPS, mempool, difficulty, finalized height |
| GET | `/api/chain/stats` | Per-block stats history (last 50 blocks) |
| GET | `/api/chain/finality` | BFT finality status and recent voting rounds |
| GET | `/api/network/peers` | Connected peer list with sync state |
| GET | `/healthz` | Health check |

### Blocks & Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/blocks` | Paginated block list |
| GET | `/api/blocks/:hashOrHeight` | Block detail |
| GET | `/api/blocks/:hashOrHeight/fees` | Per-block fee breakdown: coinbase, account-model fees, swept UTXO fees, total miner earnings |
| POST | `/api/blocks/submit` | Submit a solved PoS block — validates residual threshold, ±300s drift guard, `prevHash:nonce` replay rejection; broadcasts `new_block` over WebSocket; persists to Postgres |
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
| POST | `/api/utxo/spend` | Broadcast a UTXO transaction; fee credited to next block's miner |

### Smart Contracts (WASM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contracts` | List deployed contracts |
| GET | `/api/contracts/examples` | Example contract bytecode/ABI |
| GET | `/api/contracts/:address` | Contract detail |
| GET | `/api/contracts/:address/storage` | Contract storage dump |
| GET | `/api/contracts/:address/events` | Rolling event log (last 200 `log()` calls) |
| POST | `/api/contracts/deploy` | Deploy WASM bytecode |
| POST | `/api/contracts/:address/call` | Call a contract method. When `caller` is set, `publicKey` + `signature` (Ed25519 over `"contract-call:{address}:{methodId}:{caller}"`) are required — prevents impersonation of fund-holding addresses |

### Arbitrage Contract

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/arbitrage/opportunities` | Bellman-Ford scan of live DEX pools; cached 4s |
| GET | `/api/arbitrage/status` | Contract address, active model, paused/circuit-tripped state |
| POST | `/api/arbitrage/set-model` | Bind a ModelRegistry model (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/pause` | Pause execution (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/unpause` | Resume + clear circuit breaker (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/execute` | Trigger on-chain arbitrage trade (owner-only at contract level; circuit breaker + hard cap apply) |

### CrossChainRelay Contract

Federated m-of-n cross-chain attestation. Bonded relayers sign inbound state commitments; fraudulent attestations can be challenged and slashed within a configurable window.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/relay/info` | Contract address, m-of-n threshold, registered relayer set |
| POST | `/api/relay/register` | Register a relayer and bond EQU into escrow (requires `X-Admin-Key`) |
| DELETE | `/api/relay/register/:addr` | Revoke a relayer and return their bond (requires `X-Admin-Key`) |
| PATCH | `/api/relay/threshold` | Update m-of-n signing threshold (requires `X-Admin-Key`) |
| POST | `/api/relay/attest/inbound` | Submit an m-of-n signed inbound attestation (permissionless; contract verifies every signature) |
| GET | `/api/relay/attest/inbound/:chainId/:seq` | Attestation status, commitment hash, signers, and block height |
| POST | `/api/relay/attest/inbound/:chainId/:seq/finalize` | Finalize an unchallenged attestation after the challenge window (permissionless) |
| POST | `/api/relay/attest/inbound/:chainId/:seq/challenge` | Slash all signers of a fraudulent attestation (requires `X-Admin-Key`) |
| POST | `/api/relay/outbound/:chainId` | Publish an outbound state commitment (caller must be a registered relayer) |
| GET | `/api/relay/outbound/:chainId/seq` | Current outbound sequence number for a chain |

### Models (ModelRegistry)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List all proposed/verified/challenged models |
| POST | `/api/models/:id/verify` | Verify a model after its challenge window (re-runs NTK residual via CLI) |
| POST | `/api/models/:id/challenge` | Challenge a model with competing support data; slashes bond on success |

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
| GET | `/api/validators/:addr/fees` | Per-block miner fee income for this validator |
| GET | `/api/validators/:addr/earnings` | Aggregate coinbase + fee totals |
| POST | `/api/validators/:addr/slash` | Slash a validator (requires `X-Admin-Key` header — accepts `ADMIN_KEY` or `ADMIN_API_KEY`; superseded by on-chain multisig when configured) |
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
| POST | `/api/dex/swap` | Execute a swap (constant-product AMM, 0.3% fee) |
| POST | `/api/dex/liquidity/add` | Add liquidity to a pool |
| GET | `/api/dex/swaps` | Recent swap history |
| GET | `/api/dex/positions/:provider` | Liquidity positions for an address |

### Network & Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Node sync state and peer heights |
| GET | `/api/sync/headers` | Headers-first block sync (`?from=N&to=M`, max 200) |
| GET | `/api/gossip` | Recent Gossipsub propagation events |

### Developer Tools

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/faucet` | Drip 1,000 EQU to any address (1h cooldown) |
| GET | `/api/faucet/status/:address` | Faucet cooldown status |
| GET | `/metrics` | Prometheus metrics — chain, validators, staking, DEX, mempool, UTXO pending fees |
| GET | `/metrics/stratum` | Prometheus metrics — Stratum pool: connections, sessions, per-IP rejection counters |

### Mobile

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mobile/version` | Publish a new APK version for the in-app update check (admin) |
| GET | `/api/mobile/version/latest` | Latest published APK version and download URL |

---

## Block Explorer

Available at `/` in the running preview. Pages:

- **Dashboard** — live height, TPS, mempool pressure, residual quality, network sparkline, latest blocks and transactions
- **Blocks** — paginated block list with consensus fields (height, hash, miner, reward, residual, age)
- **Block detail** — full header, miner, transactions, and Miner Fee Breakdown panel (coinbase reward + account-model fees + swept UTXO fees = total miner earnings)
- **Transaction detail** — from/to, amount, fee, gas, confirmation status
- **Address** — balance, nonce, full transaction history
- **Mempool** — live pending pool with pressure meter and broadcast dialog
- **Network** — connected peers, latency coloring, sync height
- **Validators** — active validator set with stake shares, commission, uptime, and slash history; per-validator detail with Fee Earnings tab showing block-by-block miner fee income
- **Governance** — submit and vote on proposals (text or parameter-change); live quorum/tally bars; chain parameters panel; auto-executes on passage; Ed25519-signed votes verified server-side
- **Faucet** — 1,000 EQU drip per address per hour; live cooldown status
- **Wallet** — self-custody Ed25519 wallet (BIP-39 mnemonic, raw keypair, private key import, AES-256-GCM keystore, Ledger via WebHID, m-of-n multisig, transaction signing and broadcast)
- **Smart Contracts** — WAT textarea editor, in-browser wabt compile, ABI editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage viewer, bytecode hash
- **DEX** — liquidity pool overview, swap interface (constant-product AMM), add liquidity, swap history, per-address liquidity positions, live Arbitrage Opportunities panel (Bellman-Ford cycle detection, 15s refresh)
- **Models** (`/models`) — permissionless AI model registry; propose a model with a staked bond, verify after the challenge window, or challenge with matching support data to slash a fraudulent claim; countdown timer, proposer info, status badges
- **Arbitrage** (`/arbitrage`) — active model binding, recent profit history, circuit-breaker status, owner pause/unpause controls; execution is contract-gated (see `LIMITATIONS.md`)
- **Cross-Chain Relay** (`/relay`) — live view of the CrossChainRelay WASM contract: m-of-n threshold, registered relayer set with bond status, and an attestation lookup tool (enter chain ID + sequence number to inspect status, commitment hash, signers, and finalization block); auto-refreshes every 15s
- **Staking** — personal staking dashboard for delegating to validators
- **Admin** — multisig proposal management (`/admin/multisig`)

All data refreshes every 10 seconds via React Query; WebSocket pushes instant cache invalidation on new blocks.

---

## Wallet

Available at `/wallet`. Fully self-custody, browser-side.

- **Create — Seed phrase (recommended):** BIP-39 mnemonic (12/24-word) + SLIP-0010 Ed25519 HD derivation (`m/44'/600'/account'/0'/index'`), mnemonic-confirmation step, optional AES-256-GCM (PBKDF2, 100k iterations) encrypted keystore in `localStorage`.
- **Create — Raw keypair:** single Ed25519 key, no recovery phrase.
- **Import:** restore from a 64-char hex private key, a mnemonic, or an encrypted keystore file.
- **Hardware wallet:** Ledger support via WebHID/WebUSB transport (`wallet/ledger.ts`).
- **Multi-sig:** m-of-n Ed25519 threshold signing (`WalletMultisig.tsx`, `createMultisigAddress` / `signForMultisig` / `verifyMultisigThreshold`).
- **Send:** builds and signs a transaction, broadcasts to the mempool.
- **Balance:** live balance and nonce from the chain, recent transaction history.

Address derivation: `SHA-256(raw_pubkey_bytes).slice(0, 20)` rendered as 40 hex chars — identical to the Rust wallet.

---

## Consensus

### Adaptive Difficulty

After each block the node recomputes the difficulty threshold based on the rolling average block time (last 10 blocks). Target is **15 seconds**. Adjustment capped at ±20% per block:

```
newDifficulty = currentDifficulty × (targetBlockTime / avgBlockTime)
               clamped to [0.80×, 1.20×] of currentDifficulty
```

### BFT Finality Gadget

Each block triggers a Tendermint-style finality round. All active validators cast signed votes for the block hash. When ≥ ⅔ of total bonded stake has voted, the block is marked **finalized**. `finalizedHeight` advances with every new finalized block.

### Validator Set & Slashing

Four genesis validators start with bonded stake. Any validator can be slashed:

| Reason | Slash % | Effect |
|--------|---------|--------|
| `double_sign` | 5% of stake | Permanent removal |
| `downtime` | 1% of stake | Uptime penalty; jail after 3 events |
| `invalid_block` | 1% of stake | Uptime penalty |

### ZK Proof of Stationarity

`chain/zkproof.ts` generates a Groth16-shaped proof over the residual using real BN254 elliptic-curve scalar multiplication via `@noble/curves/bn254`. The `pi_a` and `pi_c` points are genuine G1 curve points; `pi_b` is a G2 dummy pending full Groth16 pairing verification. `chain/zk-encoding.ts` is the single source of truth for encoding residuals and block hashes as BN254 field elements — used by both the TS prover and the Rust `consensus-api` binary so public inputs are always bit-identical.

---

## DEX (Automated Market Maker)

Two pools are seeded at genesis: `EQU-WBTC` and `EQU-USDC`. The AMM uses the constant-product formula:

```
x × y = k        (0.3% fee applied to amountIn)
```

Features: swap, add liquidity, price quotes with impact calculation, swap history, and per-provider liquidity positions.

### Arbitrage Detection

`GET /api/arbitrage/opportunities` scans live DEX pool reserves for negative-weight cycles using a Rust Bellman-Ford detector (`variational-ai/src/arbitrage.rs`, exposed as the `variational-ai-arbitrage-cli` binary and invoked from the API server exactly like the residual-verification CLI). Each opportunity reports the token cycle, implied profit factor, and an optimal trade size computed via `StationarySolver`. The Explorer's Dex page shows a live "Arbitrage Opportunities" panel refreshing every 15s.

`pnpm --filter @workspace/scripts run seed-arbitrage-demo` seeds a synthetic mispriced WBTC-USDC pool (dev-only, in-memory, resets on restart) so the panel has a real cycle to display without waiting for genuine market drift.

### Arbitrage Execution (contract-gated)

`POST /api/arbitrage/execute` triggers a real on-chain arbitrage trade via the `Arbitrage` WASM contract. The contract's safety rails are the load-bearing defense:

- **Hard trade cap** — `arbitrageMaxTradeAmount` (governance-controlled, bounded 1M–1T base units); exceeded amounts are rejected before any swap occurs
- **Rolling circuit breaker** — max 5 executions per `arbitrageWindow` block window; the contract auto-pauses if the limit is hit and requires owner unpause to resume
- **Live model check** — the configured ModelRegistry model must be `Verified` and past the `arbitrage_model_update_delay` maturity period; a slash takes effect immediately (non-cached)
- **Owner restriction** — `execute_arbitrage` is owner-only; the contract checks `is_owner()` as the first gate so the caller must be authenticated and match the stored owner address
- **Atomic settlement** — trade is a single `dex_multi_swap` host call; there is no reentrancy window between quoting and settling

Admin routes (`set-model`, `pause`, `unpause`) additionally require the `X-Admin-Key` header (same `ADMIN_KEY`/`ADMIN_API_KEY` pattern as validator slashing). See `LIMITATIONS.md` for the known no-rollback behavior when a swap clears but undershoots the caller's minimum-profit target.

---

## Staking

Any address can bond EQU to a validator via `POST /api/stake`. Unbonding has a **10-block waiting period** before funds are returned. Delegators share in block rewards proportionally to their bonded stake.

---

## Smart Contracts & EVM

- `chain/wasm.ts` implements a deterministic WASM execution environment using Node's built-in `WebAssembly` — contract deploy, storage get/set, gas accounting.
- `routes/evm.ts` exposes an EVM-shaped JSON-RPC endpoint (chain ID `1337`) with address/block/transaction format translation for Ethereum tooling.

---

## Networking

### Gossipsub Transaction Propagation

Every broadcasted transaction is gossipped to all connected peers. A simulated second-hop propagation fires 200ms later, replicating Gossipsub fan-out. All events logged in `/api/gossip`.

### Headers-First Block Sync

Nodes catching up can fetch block headers in bulk via `/api/sync/headers?from=N&to=M` (up to 200 per request). Full block bodies fetched individually via `/api/blocks/:height`.

---

## Security & Rate Limiting

### HTTP submission (`POST /api/blocks/submit`)

- Per-IP sliding-window rate limit (10 req/min)
- `prevHash:nonce` replay rejection (bounded LRU set)
- ±300s timestamp drift guard
- Hex-only miner address validation

### Stratum mining pool (`STRATUM_PORT`)

- Per-session rate limit (6 shares/10s), keyed by TCP socket `remoteIp` (not self-reported miner address — closes the spoofing vector)
- `jobId:nonce:extraNonce2:ntimeHex` duplicate-share rejection
- Per-IP connection cap (max 8 concurrent sockets per address)
- Proof validation: residual < 1e-7, ntime drift check, dedup, rate limit
- Stratum error codes: 20 for rate-limit/drift, 22 for duplicate share

### Contract call caller authentication

- `POST /api/contracts/:address/call` requires an Ed25519 signature whenever `caller` is set in the request body
- Request must include `publicKey` (64 hex chars, raw Ed25519) and `signature` (128 hex chars) over the canonical message `"contract-call:{address}:{methodId}:{caller}"`
- Route verifies that the public key hashes to the claimed caller address and that the signature is valid before passing `callerAddr` to the WASM VM — prevents impersonation attacks where an attacker names a victim address to debit their bond or bypass owner gates
- Calls without a `caller` field (read-only queries, stateless methods) proceed without a signature

### Admin auth

- `POST /api/validators/:addr/slash` requires `X-Admin-Key` header
- `POST /api/arbitrage/set-model`, `/pause`, `/unpause` also require `X-Admin-Key`
- `POST /api/relay/register`, `DELETE /api/relay/register/:addr`, `PATCH /api/relay/threshold`, and `POST .../challenge` all require `X-Admin-Key` — registration is admin-gated to prevent bond-theft attacks where an attacker could drain a victim's balance by forging their address as the caller
- Accepts both `ADMIN_KEY` and `ADMIN_API_KEY` environment variable names
- Superseded by the native on-chain WASM M-of-N multisig when `ADMIN_MULTISIG_ADDRESS` is configured — single key is fallback only

### CORS & general rate limiting

- `ALLOWED_ORIGINS` env var restricts CORS to a validated, comma-separated allowlist; fails closed when set
- Global `readLimiter` (300/min) + `writeLimiter` (20/min) applied across all endpoints

---

## Prometheus Metrics

### `/metrics` — Chain & Network

| Metric | Type | Description |
|--------|------|-------------|
| `equilibrium_chain_height` | Gauge | Current chain height |
| `equilibrium_chain_finalized_height` | Gauge | BFT-finalized height |
| `equilibrium_chain_finality_lag` | Gauge | Blocks behind finalized tip |
| `equilibrium_chain_difficulty` | Gauge | Current adaptive difficulty |
| `equilibrium_chain_avg_block_time_seconds` | Gauge | Rolling average block time (last 10 blocks) |
| `equilibrium_chain_target_block_time_seconds` | Gauge | Target block interval (15s) |
| `equilibrium_chain_tps` | Gauge | Transactions per second |
| `equilibrium_chain_last_residual` | Gauge | Lagrangian residual of latest block |
| `equilibrium_chain_total_tx_count` | Counter | Total confirmed transactions |
| `equilibrium_mempool_size` | Gauge | Pending transaction count |
| `equilibrium_mempool_pressure` | Gauge | Mempool fullness ratio (0–1) |
| `equilibrium_utxo_pending_fees` | Gauge | UTXO-model fees accrued since last block (awaiting sweep to miner) |
| `equilibrium_peers_total` | Gauge | Known peers |
| `equilibrium_peers_connected` | Gauge | Connected peers |
| `equilibrium_validators_active` | Gauge | Active validator count |
| `equilibrium_validators_jailed` | Gauge | Jailed validator count |
| `equilibrium_validators_slashed` | Gauge | Slashed validator count |
| `equilibrium_staking_total_bonded` | Gauge | Total bonded EQU across all validators |
| `equilibrium_validator_bonded_stake` | Gauge | Per-validator bonded stake (label: moniker) |
| `equilibrium_validator_uptime` | Gauge | Per-validator uptime ratio (label: moniker) |
| `equilibrium_validator_blocks_proposed` | Gauge | Blocks proposed per validator (label: moniker) |
| `equilibrium_validator_accumulated_rewards` | Gauge | Accumulated rewards per validator (label: moniker) |
| `equilibrium_validator_slash_count` | Gauge | Slash events per validator (label: moniker) |

### `/metrics/stratum` — Mining Pool

| Metric | Type | Description |
|--------|------|-------------|
| `equilibrium_stratum_enabled` | Gauge | 1 if pool is running, 0 if `STRATUM_PORT` is unset |
| `equilibrium_stratum_active_connections` | Gauge | Current TCP connection count |
| `equilibrium_stratum_active_sessions` | Gauge | Current authenticated miner sessions |
| `equilibrium_stratum_connections_by_ip` | Gauge | Live connection count per remote IP |
| `equilibrium_stratum_rate_limit_rejections_total` | Counter | Total rate-limit rejections |
| `equilibrium_stratum_rate_limit_rejections_by_ip` | Counter | Rate-limit rejections per remote IP |
| `equilibrium_stratum_duplicate_share_rejections_total` | Counter | Total duplicate share rejections |
| `equilibrium_stratum_duplicate_share_rejections_by_ip` | Counter | Duplicate share rejections per remote IP |
| `equilibrium_stratum_connection_cap_rejections_total` | Counter | Total per-IP connection cap rejections |
| `equilibrium_stratum_connection_cap_rejections_by_ip` | Counter | Cap rejections per remote IP |

---

## Grafana Monitoring Stack

Three pre-built dashboards in `docs/grafana/`, wired to `/metrics` and `/metrics/stratum`:

- **Chain Overview** — height, finality lag, TPS, mempool pressure, block time vs. target, peer count, PoS difficulty, UTXO pending fees
- **Validators & Staking** — active/jailed/slashed counts, total bonded stake, per-validator stake/uptime/rewards/slash events
- **Stratum Mining Pool** — connections/sessions, per-IP rejection counters for rate-limit, duplicate share, and connection cap abuse

To spin up the full Prometheus + Grafana stack (dashboards and datasource auto-provisioned):

```bash
# Edit prometheus.yml to set the API target host, then:
cd docs/grafana
docker compose up -d
# Grafana → http://localhost:3000  (admin/admin)
# Prometheus → http://localhost:9090
```

---

## Android APK (Sideload Distribution)

The Android miner app is distributed via signed APK sideload — no Play Store. CI pipeline in `android-apk-ci.yml` (copy to `.github/workflows/` to activate):

1. Cross-compiles the Rust core for `arm64-v8a`, `armeabi-v7a`, `x86_64` via cargo-ndk
2. Builds and signs the release APK with a PKCS12 keystore
3. Uploads the APK as a GitHub Actions artifact and attaches it to GitHub Releases on `mobile-v*` tags
4. On tagged releases, posts version metadata to `/api/mobile/version` for in-app update notifications

See `docs/mobile-apk-release.md` for keystore generation, secret setup, and distribution steps.

---

## variational-ai Engine

The `variational-ai` crate is the AI solver and on-chain verification engine. It ships three compiled binaries and a TypeScript bridge so the API server can call into deterministic Rust without embedding any native code in Node.

### Binaries

| Binary | Purpose |
|--------|---------|
| `variational-ai` | Benchmark runner — trains logistic, MLP, and NTK models on MNIST; prints accuracy, residual, and time |
| `variational-ai-cli` | **Verification binary** — reads a JSON request from stdin, re-runs the deterministic NTK solver on the support set, and returns `{computed_residual_fp, computed_residual_f64, valid}` to stdout |
| `variational-ai-harness` | Determinism conformance — trains all three model types, hashes every intermediate vector with SHA-256, and prints the hashes. Run on two architectures and diff the output. |

### Building

```bash
cd variational-ai
cargo build --release
# Binaries land in target/release/
```

The harness is the canonical cross-arch verification tool:

```bash
./target/release/variational-ai-harness
# LOGISTIC_THETA=<sha256>  MLP_THETA=<sha256>  NTK_ALPHA_FP=<sha256>  ALL_PASS=true
```

### TypeScript Bridge

`artifacts/api-server/src/variational-ai/bridge.ts` exposes `computeResidual(req)` and `verifyResidual(req)` — async wrappers that spawn `variational-ai-cli` as a subprocess, pipe JSON via stdin, and parse the response. The CLI binary is copied to `artifacts/api-server/variational-ai-cli` at build time.

### Determinism Guarantees

- `.cargo/config.toml` pins `target-cpu=generic` and `-C target-feature=-fma` to prevent FMA instruction differences across CPUs.
- Fixed-point arithmetic (`FIXED_SCALE = 1_000_000_000_000`) is used for on-chain residual comparison — integer subtraction, no floats in the consensus path.
- Two-run SHA-256 hash equality is verified in CI.

### Models

| Model | Solver | Notes |
|-------|--------|-------|
| `LogisticAction` | Newton-CG | Binary classification; `Parameter = Vec<f64>` |
| `MlpAction` | L-BFGS (m=10) | Two-layer ReLU MLP; forward-pass cached |
| `NtkAction` | CG kernel solve | Empirical NTK; `solve_ntk` solves `(K + λI)α = y`; gradient norm is near-zero at exact solution |

MNIST data: auto-detects IDX files in `variational-ai/data/`; falls back to synthetic Gaussian blobs if not present.

---

## Rust Crate

The `equilibrium-core` crate (not connected to the TS server — see Architecture Notes):

- `ChainState` — block DAG + UTXO-style ledger
- `StationarySolver` — gradient descent Lagrangian optimizer
- `Consensus` — block validation against residual threshold; `choose_fork` uses fixed-point `i64` comparison
- `Wallet` — Ed25519 keypair, Ledger (balance/nonce), Keystore JSON
- `ZkProof` — Arkworks/Groth16 proof stubs (ready for circuit wiring)
- `P2pNode` — libp2p Kademlia + Gossipsub networking
- FFI exports (`create_wallet`, `sign_transaction`, `verify_block`, `solve_block`) for Android/iOS JNI

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI solver | Rust, `nalgebra`, `rand_chacha`, `libm`, fixed-point i64 arithmetic |
| Consensus core | Rust, `ed25519-dalek`, `libp2p`, `ark-snark` |
| Node RPC | TypeScript, Express 5, in-memory chain state + Postgres |
| Persistence | Drizzle ORM, PostgreSQL 16 |
| API contract | OpenAPI 3.1, Orval codegen |
| Explorer/Wallet | React 18, Vite 7, Tailwind CSS v4, React Query, Wouter, Recharts |
| Wallet crypto | `@noble/ed25519` v3, `@scure/bip39`, `@scure/bip32`, Web Crypto API |
| Monitoring | Prometheus exposition format, Grafana 11, `prom/prometheus:v2.52.0` |
| Monorepo | pnpm workspaces, Node.js 20+, TypeScript 5.9 |
| Containerization | Docker (single-image node) |
| Mobile | Kotlin + JNI (Android), Swift Package (iOS), Stratum v1 TCP pool |
| CI/CD | GitHub Actions (typecheck + TS tests + Rust tests + Android APK) |

---

## What's Been Built

### Consensus & Protocol
- Proof-of-Stationarity consensus — Lagrangian optimizer finds gradient-zero solutions; `choose_fork` selects canonical chain by lowest residual using fixed-point `i64` comparison (no floats in the fork-choice path)
- Fixed-point residual arithmetic — residuals stored as `residualFp` (`i64` scaled `1e18`) in Postgres and in memory; `reorganize()` uses BigInt comparison throughout — eliminates float non-determinism in fork choice
- ZK proof of stationarity — real BN254 G1 scalar multiplication; `chain/zk-encoding.ts` is the single source of truth for `fpEncode`/`blockHashToFields` shared by TS prover and Rust `consensus-api` binary
- Governance module — full proposal lifecycle (create → vote → quorum check → auto-execute); stake-weighted voting, quorum 33.4%, Ed25519 signature verification on every vote; hard caps on parameter changes, execution timelock, slash rate-limiting, admin action logging
- Adaptive difficulty — rolling 10-block average block time, ±20% cap per block, 15s target
- BFT finality gadget — Tendermint-style validator vote rounds; block finalized at ≥ ⅔ bonded stake
- UTXO fee collection — `pendingUtxoFees` accumulator swept to block miner on every `addBlock()` call (covering auto-miner, HTTP submit, and Stratum paths); `rollbackToHeight()` restores pool on reorg; no fees burned in either balance model

### Security & Rate Limiting
- HTTP submission hardening — per-IP sliding-window rate limit, `prevHash:nonce` replay rejection (bounded LRU), ±300s timestamp drift guard, hex-only miner address check
- Stratum server hardening — rate-limit key is TCP socket `remoteIp` (not self-reported address); duplicate-share key includes `ntimeHex`; per-IP connection cap (max 8); correct Stratum error codes (20/22); proof validation against the residual threshold
- Admin auth reconciled — `POST /validators/:addr/slash` accepts both `ADMIN_KEY` and `ADMIN_API_KEY`; on-chain WASM M-of-N multisig supersedes single key when configured; fails closed (503) in production if neither key is set
- Contract call caller authentication — `POST /api/contracts/:address/call` requires Ed25519 signature over `"contract-call:{address}:{methodId}:{caller}"` whenever `caller` is set; closes bond-theft (unauthenticated `bond()` debit) and owner-gate bypass on both ModelRegistry and Arbitrage contracts
- Enforced tx signatures — `REQUIRE_TX_SIGNATURES=true`; Ed25519 batch verification wired into UTXO validation and block assembly
- CORS lockdown — `ALLOWED_ORIGINS` env var, origin-allowlist callback check, fails closed when set

### Testing
- **Rust unit tests** — 31 tests (28 in `equilibrium-core` via `cargo test --lib` + 3 in `variational-ai/src/arbitrage.rs`): wallet round-trips/sign/verify, stationary solver bounds/clamp/fixed-point, consensus `choose_fork` including fixed-point comparison, Bellman-Ford negative-cycle detection
- **TypeScript tests** — 231 tests across 7 files (`NODE_ENV=test DATABASE_URL=... pnpm --filter @workspace/api-server test`):
  - `chain.unit.test.ts` — 41 unit tests: hash256, merkleRoot, ZK proof generate/verify, difficulty adjustment, UTXO fee sweep/rollback
  - `api.integration.test.ts` — 32 integration tests via Supertest: full chain/block/tx/submission/UTXO/peer/validator/governance flow including valid votes, wrong signature → 401, address mismatch → 400
  - `contracts.integration.test.ts` — 58 tests: WASM VM deploy/call/storage, gas tracking, ABI persistence, bulk restore, REST API coverage, `contracts.deployer` filter; includes caller-auth signature verification tests
  - `multisig.integration.test.ts` — 19 tests: on-chain M-of-N proposal/approve/execute flow, replay protection, bitmask tracking
  - `models.integration.test.ts` — 19 tests: ModelRegistry propose → verify → challenge → slash flow, challenge window enforcement, bond mechanics
  - `arbitrage.integration.test.ts` — 24 tests: Arbitrage contract set-model/pause/unpause/execute flows, circuit breaker trip and reset, governance cap enforcement, model-verification gate
  - `crosschain.integration.test.ts` — 34 tests: CrossChainRelay register/revoke/threshold, inbound attestation submit/duplicate/bad-seq/finalize/challenge, challenge-window enforcement, multi-sig 2-of-2 attestation, admin-key gate on registration

### Explorer & Wallet
- Block explorer — Dashboard, Blocks, BlockDetail (with Miner Fee Breakdown panel), TxDetail, AddressDetail, Mempool, Network — all pages live with real-time React Query data
- Miner fee breakdown — `GET /api/blocks/:hashOrHeight/fees` endpoint; Explorer panel shows coinbase + account-model fees + swept UTXO fees + total per block
- Validator fee earnings — per-validator "Fee Earnings" tab aggregating block-by-block miner income
- Governance explorer — proposal list, live quorum bars, per-validator tally, chain parameters panel, vote submission with Ed25519 signing
- Testnet faucet — 1,000 EQU drip per address per hour; live cooldown status with 5s poll
- Self-custody browser wallet — BIP-39 mnemonic + SLIP-0010 Ed25519 HD derivation, raw keypair, private-key import, AES-256-GCM encrypted keystore, Ledger via WebHID, m-of-n multisig
- Smart contracts UI — WAT editor, in-browser wabt compile, ABI editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage viewer, deployer filter and skeleton loading
- Network switcher — badge + dialog in header to switch between mainnet/testnet/custom endpoints, persists to `localStorage`
- Admin dashboard — 4-tab page (Chain Health, Validators, Node, Multisig) with live metrics, gossip log, finality status, Stratum pool stats
- Scientific notation formatting — applied to residual, difficulty, rate, price impact, pool prices throughout the UI
- Timestamp bug fixed — removed double-multiplication in ValidatorDetail and Dex pages (the "56y ago" bug)
- Live arbitrage opportunity panel — Dex page shows Bellman-Ford-detected cycles (token path, profit factor, optimal size) with a 15s refresh
- Arbitrage execution page (`/arbitrage`) — active model binding, recent profit history, circuit-breaker status, owner pause/unpause controls; backed by the live `Arbitrage` WASM contract
- Cross-Chain Relay page (`/relay`) — live relay config (threshold, relayer count, contract address), registered relayer table, and attestation lookup by chain ID + sequence number; polls every 15s
- Wallet landing page guidance — first-time-user explanation of Ed25519 keys, BIP-39 mnemonics, and self-custody model; import paths clearly documented

### CrossChainRelay Contract
- **Rust WASM contract** (`contracts/cross_chain_relay/src/lib.rs`) — no-std, compiled to `wasm32-unknown-unknown`; storage-backed relayer set, bond escrow, inbound attestation queue with per-chain sequence tracking, m-of-n Ed25519 signature verification via the `verify_owner_sig` host import, challenge window enforcement via `block_number()`, outbound sequence counter
- **TypeScript wrapper** (`artifacts/api-server/src/chain/crossChainRelay.ts`) — `registerRelayer`, `revokeRelayer`, `setThreshold`, `submitInboundAttestation`, `challengeInbound`, `finalizeInbound`, `publishOutbound`, `getRelayDetails`, `getInboundStatus`
- **REST routes** (`artifacts/api-server/src/routes/crossChainRelay.ts`) — 10 endpoints; registration is admin-only to close bond-theft griefing; attestation submission is permissionless; finalization is permissionless after the challenge window
- **Auto-deploy on boot** — `deployCrossChainRelayIfNeeded()` in `chain/index.ts`; set `CROSS_CHAIN_RELAY_ADDRESS` to keep the address stable across restarts
- **`block_number()` sync** — `addBlock()` in `state.ts` calls `wasmVM.setBlockHeight(block.height)` so the challenge-window check inside the contract always reflects the current chain tip

### variational-ai Engine
- **Rust crate built and compiled** — all three solver types (LogisticAction/Newton-CG, MlpAction/L-BFGS, NtkAction/CG kernel solve) compile and run on synthetic MNIST; real IDX files supported if placed in `variational-ai/data/`
- **Deterministic math layer** — f64 helpers (`sigmoid`, `softplus`, `dot`, `axpy`, `norm2` via `libm`) + full i64 fixed-point path (`FIXED_SCALE = 1e12`: `to_fixed`, `from_fixed`, `mul_fixed`, `dot_fixed`, `norm2_fixed`, `sigmoid_fixed`, `softplus_fixed`) for bit-exact on-chain verification
- **`variational-ai-cli` binary** — stdin→JSON→NTK residual verify→stdout JSON; exit 0=valid, 1=invalid, 2=error; deployed to `artifacts/api-server/variational-ai-cli`
- **`variational-ai-harness` binary** — SHA-256 hashes every intermediate vector and final parameter set; two-run hash equality verified (determinism confirmed)
- **TypeScript bridge** (`artifacts/api-server/src/variational-ai/bridge.ts`) — `computeResidual()` and `verifyResidual()` async wrappers that spawn the CLI via child_process, pipe JSON stdin, parse JSON stdout
- **NTK math consistency fixed** — `evaluate`/`gradient`/`hessian_vec_prod`/`solve_ntk` are internally consistent: stationarity condition of `S(α) = ½‖Kα−y‖² + (λ/2)αᵀKα` gives `(K+λI)α = y`, so ‖∇S(α*)‖ is machine-epsilon at the exact solution
- **JNI bridge** (`src/jni_bridge.rs`) — `trainLogistic` and `trainNtk` exports for Android, feature-gated behind `jni-bridge`, each wrapped in `catch_unwind`
- **Cargo determinism pins** — `.cargo/config.toml` sets `target-cpu=generic -C target-feature=-fma` for cross-arch bit-exact results
- **L-BFGS descent guard** — two-loop produces non-descent direction? falls back to steepest descent before Armijo line search

### Infrastructure
- Genesis block — `genesis.json`: 7 allocations totalling 95M EQU + 4 validators × bonded stake = 100M supply; real Ed25519 keypairs
- Postgres persistence — Drizzle ORM (blocks, transactions, validators, contracts, faucet_drips, app_releases tables); `start-postgres.sh` is idempotent — unsets Replit's injected `PGHOST`/`PGDATABASE`/`PGPASSWORD`, forces correct user, runs `pnpm install --frozen-lockfile` automatically if `node_modules` is absent (cold-boot safe), survives every container restart
- Chain restoration on restart — `loadBlocksFromDb()` recovers the longest contiguous sequence from height 0 rather than resetting to genesis on any gap; prunes orphaned suffix rows from the DB so subsequent restarts converge instead of re-truncating
- WebSocket subscriptions — real-time `new_block` and `mempool_update` events; explorer cache-invalidates instantly
- Contract-first API — OpenAPI 3.1 spec → Orval → typed React Query hooks + Zod schemas
- CI/CD pipeline — `ci.yml`: `pnpm typecheck` + `pnpm test` + `cargo test --lib` on every push
- Android APK CI — `android-apk-ci.yml`: cargo-ndk cross-compile → Gradle signed release APK → GitHub Actions artifact + Release attachment on version tags; `gradlew` + `gradle-wrapper.jar` present with executable bit set; keystore generation uses `keytool` (avoids an OpenSSL 3.x AES-256-CBC incompatibility)
- Grafana monitoring stack — `docs/grafana/docker-compose.yml`: one command spins up Prometheus + Grafana with all three dashboards auto-provisioned; `prometheus.yml` targets the live API
- Stratum metrics — `GET /metrics/stratum`: Prometheus-format endpoint for pool abuse monitoring; reports `enabled 0` gracefully when the pool is off
- Load test harness — k6 with real Ed25519-signed txs, 50 VUs; 149 TPS / p95 70ms / 9,009/9,009 accepted over the live Replit dev domain
- DB indexes — `contracts_deployer_idx` and `contracts_deployed_at_idx` added

### Mobile Mining
- Android JNI bridge — `equilibrium/src/jni_bridge.rs`; `MiningWorker.kt` → JNI `solveBlock()` → `POST /api/blocks/submit` with OkHttp (retry on 5xx, no-retry on 409/422)
- iOS Swift Package — `MiningCoordinator.swift` using the BackgroundTasks API with auto-rescheduling
- Stratum v1 mining pool — TCP server in `stratum-server.ts`; starts when `STRATUM_PORT` is set; rate-limited with per-IP caps and abuse counters
- In-app update check — backend `/api/mobile/version` endpoints + Android UI; CI publishes version metadata on APK release

---

## Remaining Work

_Reconciled against the running code on 2026-07-09 — see `TODO.md` for full detail and file pointers._

### Actionable in Replit

| Priority | Item | Notes |
|---|---|---|
| 🟡 | A few residual "Loading…" text spots | Dashboard chart, ValidatorDetail delegators table, Dex pools table — most other pages already use skeletons |
| 🟡 | CrossChainRelay in CI | `crosschain.integration.test.ts` runs locally but the contract's `build.sh` isn't wired into `ci.yml` yet; the compiled `.hex` could drift from source |
| 🟡 | `rollbackToHeight()` WASM block height | `addBlock()` now calls `wasmVM.setBlockHeight()` but `rollbackToHeight()` does not — after a reorg the WASM `block_number()` returns a stale value until the next block is mined |
| 🟢 | Architecture diagram | `docs/architecture.md` with a Mermaid diagram of the full pipeline |
| 🟢 | Operator docs | `docs/validator-setup.md`, `docs/delegator-guide.md` |
| 🟢 | Automated CD | `ci.yml` only runs tests/build today — no auto-deploy on `main` push |
| 🟢 | Rust/node binary release pipeline | Android APK has one; the validator/testnet-node binary does not |
| 🟢 | Per-caller rate limit on arbitrage execute | Circuit breaker is global (shared 5-execution window); a per-caller limit would prevent a single caller burning the whole window |

### External infrastructure and ops

| Priority | Item | Notes |
|---|---|---|
| 🔴 | Multi-region sentry/validator nodes | Needs Hetzner/AWS provisioning |
| 🔴 | Postgres HA (replication + failover + backups) | Managed service or self-hosted cluster |
| 🔴 | DDoS mitigation / rate limiting at edge | Cloudflare or Hetzner DDoS protection |
| 🔴 | Final security audit | External firm, before public mainnet launch |

---

## Deployment / Infrastructure

The stack is small enough for a single low-cost VPS at testnet scale. **Hetzner** is the recommended default (NVMe-backed, generous EU bandwidth, straightforward Docker deploy):

| Component | Suggested tier | Why |
|---|---|---|
| Testnet all-in-one | CX23 (2 vCPU / 4GB) | Cheapest tier; plenty for the TS chain + explorer |
| API node (split out) | CX33 or CAX21 (ARM) | CAX is best price/performance if x86 not required |
| Postgres | CX43 or AX dedicated | RAM-heavy; dedicated AX often cheaper than CCX post-June-2026 |
| Explorer / static | CX22 or bundle onto API box | Vite build is static |
| Validator seed nodes | Multiple CX23 across regions | Cheap enough for genuine libp2p peer diversity |

**Note:** Hetzner repriced cloud servers significantly in June 2026 (CPX/CCX lines up 113–204%). CX (Cost-Optimized) and CAX (ARM) lines stayed relatively stable. Check [hetzner.com/cloud](https://www.hetzner.com/cloud) before ordering — treat the above as directional, not quotes.

---

## License

MIT
