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
| CI | `ci.yml`: typecheck + TS tests (10 files, 257+ tests) + Rust clippy/check on every push |
| Android APK CI | `android-apk-ci.yml` builds a signed sideload APK on GitHub Actions |
| Operator docs | `docs/validator-setup.md`, `docs/delegator-guide.md`, `docs/architecture.md` |
| Load-test baseline | 149 TPS sustained, p95 70 ms, 9,009/9,009 txs accepted (k6, 50 VUs) |
| Explorer UI — ContractDetail | `ContractDetail.tsx` refactored: POST contract calls use `useMutation` (React Query); removed manual loading/error state boilerplate |
| Block reward format | Consistent: all reward displays use `formatAmount` across `Blocks.tsx` and `BlockDetail.tsx`; `formatCompact` defined but not in active use |
| Explorer UI — loading skeletons | `<Skeleton>` component applied in Dashboard chart area, ValidatorDetail delegators table, DEX Arbitrage panel, DEX Pools table — plain text loading states removed |
| Inbound P2P sync callbacks | `p2pBridge.onSyncRequest` / `onLightNodeRequest` wired in `initChain()`; covered by `p2p-sync.integration.test.ts` (9 test file, 12 tests) |
| Vitest timeout | `testTimeout` raised to 300 s in `vitest.config.ts`; arbitrage stress tests that mine 100+ blocks no longer false-fail on slow CI runners |

---

## 🟡 Open (in-repo)

| # | Item | What is done | What remains |
|---|------|--------------|--------------|
| 1 | **Phone lightnode / sync RR client** | `p2p_runtime.rs` has `fetch_tip` / `set_local_tip` tip cache; `MiningWorker.kt` prefers P2P tip and polls gossip for race detection | Phone cannot yet *request* block bodies or headers from peers over P2P (no `query_sync` / lightnode RR *client* in `p2p_runtime`). HTTP submit is still required when no peer holds the body. |
| 2 | **Phone serves other phones** | Desktop sidecar answers lightnode + sync RR | `p2p_runtime.rs` has no lightnode or sync RR *server* — a phone cannot answer another phone's tip or body request |
| 3 | **Two-process P2P mesh CI** | `p2p-mesh.integration.test.ts` added (skip-safe without binary) | Needs `cargo build --release --bin p2p-sidecar` step in CI to run non-skipped |
| 4 | **Full Groth16 pairing** | G2 π_B point validated; Rust sidecar does full pairing | TS fallback omits pairing check (see `LIMITATIONS.md` §7); no circuit witness path in TS |
| 5 | **zkML / ERC-7992 DeepProve** | Ed25519 inference receipt only | On-chain model-inference circuit not implemented |

### Docs sync
`README.md` and this file are reconciled as of 2026-07-28. Keep them in sync on every substantive protocol or API change — treat **this TODO + `LIMITATIONS.md`** as the gap-truth reference.

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

1. External ops / security audit
