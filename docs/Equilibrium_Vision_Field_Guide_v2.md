# Equilibrium Vision — A Field Guide

**What it is, what makes it different, how to deploy it, and how to use it.**

---

## 1. What Equilibrium Is (in one paragraph)

Equilibrium Vision is a **mobile-first Layer-1 blockchain** built around a consensus mechanism called **Proof-of-Stationarity (PoS)** — not to be confused with Proof-of-Stake. Instead of burning energy to find hash collisions, miners solve a Lagrangian optimization problem: find the stationary point of a dynamically generated cost function where the gradient vanishes. Lower residual = better block. The chain is designed to be **verifiable on a phone**: mining, validation, and peer-to-peer mesh networking all run in-process on Android via Rust JNI.

The project is open-source, self-funded, and built by one person. It is **not a launched mainnet**. It is hardened testnet infrastructure meant to be inspected, not marketed.

---

## 2. What Makes It Different

### 2.1 Proof-of-Stationarity (not Proof-of-Work, not Proof-of-Stake)

| Mechanism | What miners do | Hardware required |
|-----------|---------------|-------------------|
| **Proof-of-Work** | Find hash < target | ASICs, massive energy |
| **Proof-of-Stake** | Lock capital, attest blocks | Capital, not compute |
| **Proof-of-Stationarity** | Solve ∇f(x) = 0 for a random cost function | A phone CPU is sufficient |

The solver uses Newton-CG and L-BFGS to find the stationary point. The residual (how close to zero the gradient is) becomes the block quality score. Difficulty adapts every block based on a rolling 10-block average, capped at ±20% per adjustment.

**Why this matters:** A miner in a developing country with a mid-range Android phone can participate at the same computational level as a datacenter. The work is mathematically verifiable in microseconds, not thermally expensive.

### 2.2 Mobile-First, Not Mobile-Compatible

Most chains treat mobile as a wallet client. Equilibrium treats mobile as a **first-class peer**, not a thin wallet: in-process libp2p, background mining, independent residual validation, QR bootstrap. The phone verifies; it does not hold the full archival state of a desktop node.

- In-process **libp2p swarm** (Gossipsub, Kademlia, mDNS, Identify, TCP + QUIC)
- **Background mining** via WorkManager (only when charging + on unmetered WiFi)
- **Mobile validator** that independently verifies residuals, Merkle roots, timestamps, and Ed25519 signatures
- **QR peer bootstrapping** — scan another phone's QR code to join the mesh without any server

When peered, the phone prefers P2P tip and body sync and validates locally. With no peers, HTTP tip/submit remains a fallback — not the preferred path.

### 2.3 Cryptographic Honesty by Design

Every claim in the codebase is scoped to what the code actually does:

- **BFT finality** is real Ed25519 vote verification + quorum when `REQUIRE_BFT_VOTES=true`; otherwise soft finality. The code says which mode is active.
- **ZK proofs:** verification runs a full BN254 Groth16 pairing check. TS proving still uses a trapdoor simulation (disabled in production). Real circuit-witness security for stationarity remains an ops/ceremony item — see `LIMITATIONS.md` §7.
- **Cross-chain relay** supports BLS aggregate attestation + optional SHA-256 Merkle inclusion. It does **not** claim full Bitcoin SPV (header chain + PoW verification) — that is honestly listed as future work.
- **Mining RNG** is fail-closed: `NODE_ENV=production` or `REQUIRE_REAL_SOLVER=true` throws rather than falling back to random residuals. No silent degradation.

### 2.4 The "Platform Is the Evaluation" Standard

There are no whitepaper promises. The repository is the source of truth. Every feature is either live in code, tested in CI, or explicitly listed as a gap. This document follows the same rule.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        PHONE (Android)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ MiningWorker│  │ P2P Swarm   │  │ Mobile Validator    │  │
│  │ (Kotlin)    │  │ (Rust JNI)  │  │ (Rust JNI)          │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘  │
│         │                │                                    │
│         └────────────────┘──→ P2P mesh (TCP/QUIC/Gossipsub) │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    DEDICATED SERVER                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ API Server  │  │ p2p-sidecar │  │ Postgres            │  │
│  │ (TypeScript)│  │ (Rust)      │  │ (blocks/tx/validators)│  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────┘  │
│         │                │                                    │
│         └────────────────┘──→ NDJSON IPC bridge              │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐                              │
│  │ Explorer    │  │ Caddy       │                              │
│  │ (React/Vite)│  │ (reverse)   │                              │
│  └─────────────┘  └─────────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

**Key design decisions:**

- **TypeScript API server** is the live testnet. It holds the canonical chain state in memory + Postgres. The Rust core is a reference consensus engine.
- **p2p-sidecar** runs as a subprocess. The TS server talks to it via NDJSON over stdio. This lets the TS stack handle HTTP while Rust handles the mesh.
- **Phone ↔ Server** communication is dual-path: P2P first (gossip + sync RR), HTTP fallback (tip data + block submission).

---

## 4. Deployment Guide

### 4.1 Server Setup (Ubuntu 24.04 LTS recommended)

**Prerequisites:**
- Node.js 20+, pnpm, PostgreSQL 16
- Rust 1.97.0+ with `wasm32-unknown-unknown` target
- Caddy (or nginx) for reverse proxy

**Step 1: Database**
```bash
# Run the idempotent bootstrap script
bash scripts/start-postgres.sh
# This creates the equilibrium database, user, and applies Drizzle schema
```

**Step 2: API Server**
```bash
export DATABASE_URL="postgresql://runner@127.0.0.1:5432/equilibrium"
export PORT=8080
export ALLOW_RANDOM_MINING=true   # Required for dev/testnet ONLY
export ADMIN_KEY="your-secret-here"

pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run start
```

**Step 3: p2p-sidecar**
```bash
cd equilibrium
cargo build --release --bin p2p-sidecar
./target/release/p2p-sidecar
```

**Step 4: Explorer**
```bash
cd artifacts/explorer
pnpm run build
# Serve the dist/ folder via Caddy
```

**Step 5: Caddyfile**
```
your-domain.com {
    reverse_proxy /api/* localhost:8080
    reverse_proxy /evm/* localhost:8080
    reverse_proxy /metrics* localhost:8080
    file_server {
        root /path/to/artifacts/explorer/dist
    }
}
```

### 4.2 Phone Setup (Sideload APK)

**Option A: Pre-built release**
1. Download `app-release.apk` from [GitHub Releases](https://github.com/CreoDAMO/Equilibrium-Vision/releases)
2. Android Settings → Apps → Special app access → Install unknown apps → allow your browser
3. Open the APK and install

**Option B: Build from source**
```bash
cd equilibrium
# Cross-compile Rust core for Android
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64   -o mobile/android/app/src/main/jniLibs build --release --lib

# Build APK
cd mobile/android
./gradlew assembleRelease
# Signed APK lands in app/build/outputs/apk/release/
```

### 4.3 Environment Variables Reference

| Variable | Required? | Purpose |
|----------|-----------|---------|
| `DATABASE_URL` | Yes | Postgres connection string |
| `PORT` | Yes | API server port |
| `ALLOW_RANDOM_MINING` | Dev only | Allows TS miner without real Rust solver. **Must NOT be set in production.** |
| `ADMIN_KEY` | Yes (production) | Gates admin routes (slash, relay register) |
| `P2P_BOOTSTRAP` | No | Comma-separated multiaddrs for initial peers |
| `STRATUM_PORT` | No | Enables Stratum v1 mining pool on this port |
| `CROSS_CHAIN_RELAY_ADDRESS` | No | Pins relay contract address across restarts |

---

## 5. Usage Guide

### 5.1 Mining

**From the phone:**
1. Open the Equilibrium Miner app
2. Select mode: HTTP, Hybrid, or P2P
3. Tap **"Start embedded P2P node"**
4. The WorkManager scheduler will begin mining when conditions are met (charging + unmetered WiFi)
5. A persistent notification shows current height and peer count

**From the command line (server):**
```bash
cd equilibrium
cargo run --bin testnet-node
```

**Via Stratum pool:**
Configure your miner to point at `stratum+tcp://your-server:STRATUM_PORT`. The pool accepts standard v1 jobs and validates shares against the residual threshold.

### 5.2 Joining the P2P Mesh

**Method 1: QR Code (phone-to-phone)**
1. Both phones: Start P2P node
2. Phone A: Tap **"Join Network (QR / Share)"** — a QR code appears
3. Phone B: Tap **"Scan QR"** and scan Phone A's code
4. Status panel should show **Peers: 1** within seconds

**Method 2: Manual multiaddr**
1. Find the server's or peer's listen address (e.g., `/ip4/192.168.1.42/tcp/9000/p2p/Qm...`)
2. Paste into the **"Paste QR/NFC invite or libp2p multiaddr"** field
3. Tap **"Connect first peer"**

**Method 3: Deep link**
Click or NFC-tap an `equilibrium://bootstrap?addr=...` URI. The app opens and auto-connects.

### 5.3 Using the Explorer

Open your server's domain (or `localhost:5000` if running locally).

**Key pages:**
- **Dashboard** — live height, TPS, mempool pressure, residual quality
- **Blocks** — paginated list with miner, reward, residual
- **Wallet** — self-custody Ed25519 wallet (BIP-39 mnemonic, raw keypair, Ledger support)
- **DEX** — swap, add liquidity, view arbitrage opportunities
- **Validators** — stake, delegate, view slash history
- **Governance** — propose, vote, view quorum
- **Smart Contracts** — deploy WASM, call methods, view storage
- **Cross-Chain Relay** — lookup attestations by chain ID + sequence

**Testnet faucet:**
Visit `/faucet` or call `POST /api/faucet` to drip 1,000 EQU per address per hour.

### 5.4 Contract Interaction

**Deploy a WASM contract:**
```bash
curl -X POST https://your-server/api/contracts/deploy   -H "Content-Type: application/json"   -d '{"bytecode":"<hex>","abi":{...}}'
```

**Call a contract method (with caller auth):**
```bash
curl -X POST https://your-server/api/contracts/0x.../call   -H "Content-Type: application/json"   -d '{
    "methodId": 1,
    "args": [...],
    "caller": "d1c2c0a4...",
    "publicKey": "<64-hex>",
    "signature": "<128-hex>"
  }'
```
The signature is Ed25519 over `"contract-call:{address}:{methodId}:{caller}"`.

---

## 6. Honest Scope — What Is NOT Claimed

This section exists so no one mistakes testnet infrastructure for a finished product.

| Claim | Status | Truth |
|-------|--------|-------|
| Launched mainnet | ❌ Not claimed | Testnet only. Mainnet not asserted until validation and ZK gaps close. |
| Fully offline phone mesh | ❌ Not claimed | First boot requires at least one peer or HTTP fallback. No built-in global seed nodes yet. |
| Full Bitcoin/Ethereum SPV bridge | ❌ Not claimed | BLS aggregate + optional Merkle inclusion under a submitted root. Full foreign header-chain verification is future work. |
| zkML / in-circuit model inference | ❌ Not claimed | Ed25519-signed inference receipts only. On-chain model verification circuit not implemented. |
| Google Play Store distribution | ❌ Not claimed | Sideload APK only. Play Store is deferred. |
| Production randomness source | ❌ Not claimed | `ALLOW_RANDOM_MINING` is dev-only. Production requires the real deterministic solver. |
| Hardware TEE enclave | ❌ Not claimed | Software/stub attestation mode. Hardware enclave is pending. |

**What IS real and verifiable:**
- ✅ 262 tests (33 Rust + 229 TypeScript) passing in CI
- ✅ SMT `stateRoot` computed and verified on every block
- ✅ Mobile APK with in-process libp2p, QR bootstrapping, and background mining
- ✅ BLS aggregate cross-chain attestation with optional Merkle-SPV
- ✅ Deterministic variational-AI solver with cross-architecture hash verification
- ✅ 149 TPS sustained load test (k6, 50 VUs, real Ed25519 signed txs)
- ✅ Ceremony path: CircomReduction prove/verify against imported keys is in-tree; production still depends on placing keys and not using the TS trapdoor prover

---

## 7. Verification — How to Check Every Claim

The reader is invited to verify rather than trust.

| Claim | How to Verify |
|-------|---------------|
| Code exists | `git clone https://github.com/CreoDAMO/Equilibrium-Vision` |
| Tests pass | `pnpm test` (TS) + `cargo test --lib` (Rust) |
| APK builds | Follow `docs/mobile-apk-release.md` |
| SMT root guard | Read `chain/state-root.ts` → `getVerifiedStateRoot` |
| Mining determinism | Run `variational-ai-harness`, compare SHA-256 hashes across two runs |
| P2P mesh works | Install APK on two phones, scan QR, check `Peers: 1` |
| Explorer is live | Run the server stack, open `/` in a browser |
| LIMITATIONS are honest | Read `LIMITATIONS.md` in the repo root |
| Release is real | Check [GitHub Releases](https://github.com/CreoDAMO/Equilibrium-Vision/releases) for `mobile-v0.1` |

---

## 8. Who Built This and Why

Equilibrium Vision was built by **Jacque Antoine DeGraff**, a self-taught developer with no college degree, working alone with no outside capital and no team. AI was used as a development tool — the way any engineer uses a compiler or a library — not as a substitute for reading cryptography, consensus, and networking primaries.

The architectural philosophy is the same as AMAIMA and BasisGuard: **accountability should be cryptographically verifiable rather than dependent on institutional authority.** The code is the evaluation. The reader is not asked to accept claims on the basis of credentials; the reader is invited to verify.

**Contact:** jacquedegraff81@gmail.com  
**Primary platform:** [amaima.live](https://amaima.live)  
**Repository:** [github.com/CreoDAMO/Equilibrium-Vision](https://github.com/CreoDAMO/Equilibrium-Vision)

---

*Last updated: August 2026. This document is a living reference. If the code changes, this document should be updated to match. The repository is the source of truth; this page is a map.*
