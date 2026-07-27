# Equilibrium — TODO & Gap Analysis
_Last updated: 2026-07-27 — reconciled against `main` (incl. state-root guard, P2P mesh, arbitrage execute)_

---

## ✅ Completed (verified against live code)

| Area | Notes |
|------|--------|
| Arbitrage **detection + execution** | Read-only `GET /api/arbitrage/opportunities` **and** live `POST /api/arbitrage/execute` with hard cap, circuit breaker, model gate, owner check, per-caller 2/15s rate limit |
| SMT + `stateRoot` | Computed on every block; persisted as `blocks.state_root` in Postgres |
| Cold-cache proof guard | `chain/state-root.ts` → `getVerifiedStateRoot`; HTTP proofs reject 409/503 if rebuilt SMT ≠ tip `stateRoot` or root missing/zero |
| P2P mesh | `p2p-sidecar`: Gossipsub, mDNS, Identify, Kademlia, light-node RR, sync RR, **TCP + QUIC** (`OrTransport`) |
| TS ↔ sidecar | `p2p-bridge.ts` (NDJSON IPC); mining gossips via `p2pBridge.gossipBlock` |
| Light-node HTTP | `/lightnode/tip\|headers\|sync\|proof/*\|peers\|contributions` — proofs backed by `getVerifiedStateRoot` |
| Auth / rate limits / Stratum / CORS | Per-IP sliding windows, replay rejection, drift guard, Stratum error codes 20/22 |
| ModelRegistry inference attestation | Ed25519 receipt only — **not** zkML (see `LIMITATIONS.md` §1b) |
| CrossChainRelay | Deploy + routes + challenge window + admin-gated registration |
| variational-ai determinism | CLI + harness + fixed-point path; determinism-pinned Cargo config |
| Android miner path | JNI `solveBlock` → HTTP submit; `P2PNode` bootstrap invite URI surface |
| Kinetic Block Timeline | `/matrix` — live 3D block visualisation (Three.js/R3F) with WebGL guard |
| Grafana stack | `docs/grafana/docker-compose.yml` — Prometheus + Grafana auto-provisioned |
| CI | `ci.yml`: typecheck + TS tests (8 files, 245 tests) + Rust clippy/check on every push |
| Android APK CI | `android-apk-ci.yml` builds a signed sideload APK on GitHub Actions |
| Operator docs | `docs/validator-setup.md`, `docs/delegator-guide.md`, `docs/architecture.md` |
| Load-test baseline | 149 TPS sustained, p95 70 ms, 9,009/9,009 txs accepted (k6, 50 VUs) |

---

## 🟡 Open (in-repo)

### 1. Phone as full peer without Express
`P2PNode.kt` is a thin JNI/invite surface. The default mining path is still HTTP submit via `MiningWorker`. An in-process libp2p swarm on the device (gossip + light-node sync + SMT verify + tx submit without an Express server) is **not** the production path yet.  
_Prerequisite: real Rust JNI implementations for `P2PNode.start/stop/connect`; UI for QR/NFC invite flow._

### 2. Inbound P2P body-accept end-to-end tests
The sidecar emits `sync_request` / `lightnode_request` events and bridges them to the TS chain. CI should cover the full hash → body-fetch → validate → `addBlock` path under dual TCP/QUIC transport.

### 3. Durable snapshots before safe pruning
`pruneOldBlocks` correctly no-ops unless `ENABLE_UNSAFE_PRUNING=true`. Safe mobile-sized pruning requires persisted ledger/UTXO/contract snapshots, not only block row deletion.

### 4. Explorer UI debt (non-consensus)
- `ContractDetail.tsx` / `AdminMultisig.tsx` still monolithic / use raw `fetch()` in places instead of the generated `@workspace/api-client-react` hooks
- Block reward display format inconsistency (`formatCompact` vs `formatAmount`) across blocks list, block detail, and fee panel

### 5. Docs sync
`README.md` and this file are now reconciled (2026-07-27). Keep them in sync on every substantive protocol or API change — treat **this TODO + `LIMITATIONS.md`** as the gap-truth reference.

---

## 🔵 External / ops

| Item | Notes |
|------|-------|
| Multi-region validators / sentries | Cloud/VPS provisioning |
| HA Postgres + backups | Managed service or self-hosted cluster |
| Edge DDoS mitigation | Cloudflare / provider protection |
| External security audit | Before public mainnet |
| Store distribution | Sideload-first by design; Play Store / App Store deferred |

---

## Priority

1. Android in-process swarm (JNI implementations + QR/NFC invite UI)
2. Inbound P2P sync CI coverage (hash → addBlock under TCP+QUIC)
3. Snapshot model → then re-evaluate pruning for mobile disk
4. Explorer UI polish (contracts / admin / reward format)
5. External ops / security audit
