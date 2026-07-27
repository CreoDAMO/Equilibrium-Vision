# Equilibrium — TODO & Gap Analysis
_Last updated: 2026-07-27 — post-session reconciliation_

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
| Android miner path | JNI `solveBlock` + full in-process libp2p swarm (`p2p_runtime.rs` → `P2PNode.kt`); `MiningWorker.kt` polls gossip from peers during solve |
| Inbound P2P sync CI | `src/__tests__/p2p-sync.integration.test.ts` — covers hash → body-fetch → validate → `addBlock` under dual TCP/QUIC transport |
| Durable snapshots + safe pruning | `persistence.ts`: `saveStateSnapshot` / `loadLatestSnapshot` / `pruneOldBlocks` (requires snapshot coverage). `chain/index.ts`: snapshot fast-path in `initChain` (restore ledger+UTXO from snapshot, replay only post-snapshot blocks), periodic snapshots every 100 blocks in mining loop, `safelyPruneOldBlocks()` export |
| Kinetic Block Timeline | `/matrix` — live 3D block visualisation (Three.js/R3F) with WebGL guard |
| Grafana stack | `docs/grafana/docker-compose.yml` — Prometheus + Grafana auto-provisioned |
| CI | `ci.yml`: typecheck + TS tests (8 files, 245 tests) + Rust clippy/check on every push |
| Android APK CI | `android-apk-ci.yml` builds a signed sideload APK on GitHub Actions |
| Operator docs | `docs/validator-setup.md`, `docs/delegator-guide.md`, `docs/architecture.md` |
| Load-test baseline | 149 TPS sustained, p95 70 ms, 9,009/9,009 txs accepted (k6, 50 VUs) |
| Explorer UI — ContractDetail | `ContractDetail.tsx` refactored: POST contract calls use `useMutation` (React Query); removed manual loading/error state boilerplate |
| Block reward format | Consistent: all reward displays use `formatAmount` across `Blocks.tsx` and `BlockDetail.tsx`; `formatCompact` defined but not in active use |

---

## 🟡 Open (in-repo)

### 1. Explorer UI polish (remaining)
- Loading skeleton pattern not applied in: Dashboard chart area, ValidatorDetail delegators table, Dex pools table (plain "Loading…" text)
- `ContractDetail.tsx` / `AdminMultisig.tsx` still use direct `fetch()` queryFn inside `useQuery` for GET endpoints where no generated hook exists — acceptable pattern but not using `@workspace/api-client-react` hooks

### 2. Docs sync
`README.md` and this file are reconciled as of 2026-07-27. Keep them in sync on every substantive protocol or API change — treat **this TODO + `LIMITATIONS.md`** as the gap-truth reference.

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

1. Explorer UI polish (loading skeletons in Dashboard, ValidatorDetail, Dex)
2. External ops / security audit
