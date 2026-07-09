# Equilibrium — TODO & Gap Analysis
_Last updated: 2026-07-08 (session 3) — reconciled against actual code, not prior session notes_

> **Note on this update:** this file had drifted significantly from the codebase — most items marked open below were already fixed in a prior session but never checked off here. Everything in "Completed" was verified directly against the running code on 2026-07-08, not just carried over from memory.

---

## ✅ Completed (verified against live code)

| Area | What was done |
|------|--------------|
| **Arbitrage detection (new)** | Rust `arbitrage.rs` Bellman-Ford negative-cycle detector wired into a read-only `GET /api/arbitrage/opportunities` endpoint via a second CLI binary (`variational-ai-arbitrage-cli`); scans live DEX pool reserves, sizes each cycle with `StationarySolver`, surfaces up to `limit` (max 20) distinct opportunities. Explorer Dex page shows a live "Arbitrage Opportunities" panel, 15s auto-refresh. Dev-only `POST /api/dex/pools/seed-arbitrage-demo` + `pnpm --filter @workspace/scripts run seed-arbitrage-demo` seed a synthetic mispriced pool so the panel can be demoed without waiting for a real 3-pool cycle to emerge |
| **esbuild path-resolution bug (new)** | `bridge.ts` and `wasm.ts` resolved their CLI binary paths one directory level too shallow once bundled (`import.meta.url` isn't rewritten per-source-file by esbuild) — silently broke both the arbitrage CLI and the pre-existing residual-verification CLI in the production bundle. Fixed with a `process.cwd()`-first, `fs.existsSync`-checked resolver in both files |
| **Auth** | `ADMIN_KEY` / `ADMIN_API_KEY` mismatch reconciled; both accepted; fails closed (503) in production if neither is set |
| **Rate limiting** | Global `readLimiter` (300/min) + `writeLimiter` (20/min, all POST/PUT/PATCH/DELETE) in `app.ts`; HTTP `/api/blocks/submit` has its own per-IP sliding-window limit, `prevHash:nonce` replay rejection, ±300s drift guard |
| **Stratum hardening + proof validation** | Rate-limit keyed by TCP socket `remoteIp`; duplicate-share key includes `ntimeHex`; per-IP connection cap (8); error codes 20/22; `onSubmit` validates residual < `RESIDUAL_THRESHOLD` (1e-7) before block assembly — confirmed live in `stratum-server.ts` |
| **CORS lockdown** | `ALLOWED_ORIGINS` env var, allowlist callback, fails closed when set |
| **`contracts.deployer` DB index** | `contracts_deployer_idx` + `contracts_deployed_at_idx` both present in `lib/db/src/schema/contracts.ts` |
| **UTXO fee collection** | Fees credited to miner via `pendingUtxoFees` sweep on every `addBlock()` path; rollback restores the pool; nothing burned |
| **"56y ago" timestamp bug** | `timeAgo()` in `lib/format.ts` is correct (`timestamp * 1000` handled once, in the helper); verified across `Blocks.tsx`, `Dashboard.tsx`, `BlockDetail.tsx`, `ValidatorDetail.tsx`, `Dex.tsx` — none double-multiply |
| **Nav overflow at 1280px** | `Layout.tsx` nav already collapses to icon-only (with `aria-label`/`title` tooltips) below the `2xl` breakpoint — no truncated labels |
| **Scientific notation formatting** | `formatScientific()` in `lib/format.ts`, applied across Dashboard, Governance, Dex, Blocks, BlockDetail |
| **Dashboard chart legend** | "Mempool Size & PoS Residual (Last 20 Blocks)" has a `<Legend>`, labeled dual Y-axes, and a scientific-notation tooltip formatter |
| **DEX swap output preview** | Swap panel shows a live "You receive ≈ X" quote computed from the constant-product formula before the user confirms |
| **Skeleton loading states** | `components/ui/skeleton.tsx` used across Blocks, Dashboard, Validators, ValidatorDetail, AddressDetail, Contracts, Governance, Mempool, Network, Staking, TxDetail, AdminMultisig, wallet — most pages covered (a few isolated spots still show plain "Loading…" text, see Open Items) |
| **Error states with retry** | `components/ErrorBoundary.tsx` (full-screen, with reset button) wraps the app in `App.tsx` |
| **Validator Fee Earnings** | `GET /api/validators/:addr/earnings` aggregate endpoint exists (`routes/validators.ts`); UI tab has a proper empty state ("No fee-paying transactions have been included...") instead of looking broken |
| **Postgres cold-start + auto-install** | `start-postgres.sh` unsets Replit's injected env vars, forces correct role, runs `pnpm install --frozen-lockfile` automatically when `node_modules` is missing; `.replit` Project workflow runs sequentially (Postgres → API Server → Explorer) with `waitForPort` gates |
| **Chain persistence on restart** | `loadBlocksFromDb()` recovers the longest contiguous sequence from height 0 and prunes orphaned suffix rows instead of resetting to genesis on any gap |
| **CI** | `ci.yml` runs typecheck + TS tests + Rust `cargo check`/clippy on every push/PR |
| **Android APK CI** | `android-apk.yml` (copied from `android-apk-ci.yml`) builds a signed sideload APK via GitHub Actions |
| **Grafana stack** | `docs/grafana/docker-compose.yml` — one command spins up Prometheus + Grafana with all 3 dashboards auto-provisioned |
| **Inference attestation (new)** | `ModelRegistry` gained an Ed25519-signed inference receipt: `submit_inference_attestation`/`get_inference_status`/`get_capabilities` in `contracts/model_registry/src/lib.rs`, wired through `chain/modelRegistry.ts` to `POST /api/models/:id/inference-proof` + `GET /api/models/:id/inference-status`. Deliberately scoped as attribution ("who signed this input→output claim"), not a zkML correctness proof — see `LIMITATIONS.md` §1b. 4 new integration tests (197 total TS tests) |

---

## 🟡 Open Items (genuinely unresolved — verified against code on 2026-07-08)

### 1. `ContractDetail.tsx` / `AdminMultisig.tsx` are still monolithic
427 and 836 lines respectively; both still use raw `fetch()` calls (10–11 call sites each) instead of the generated `@workspace/api-client-react` hooks, so loading/error/refetch handling is inconsistent with the rest of the app.
- Extract sub-components (ABI call panel, storage inspector, proposal list) into their own files.
- Replace `fetch()` with generated hooks (`useGetContract`, etc.).

### 2. Wallet landing page — guidance is minimal
Only a one-line description ("Self-custody, browser-side Ed25519 wallet. Keys never leave your browser.") — no explanation of what Ed25519/a private key/mnemonic actually means for a first-time user, or which app features require a connected wallet.

### 3. Block reward display is inconsistently formatted
`Blocks.tsx` list uses `formatCompact()` (renders "50M EQU"), but `BlockDetail.tsx` uses `formatAmount()` in two places (full "50,000,000 EQU"). Pick one convention and apply it consistently across the blocks list, block detail, and fee breakdown panel.

### 4. A few isolated raw "Loading…" strings remain
Most pages have proper skeletons, but `Dashboard.tsx` (chart area), `ValidatorDetail.tsx` (delegators table), and `Dex.tsx` (pools table) still show plain loading text instead of a skeleton — minor polish, low effort given the pattern already exists elsewhere.

### 5. Architecture diagram
No `docs/architecture.md` exists showing how the Rust core, TS API server, Explorer, mobile app, Stratum server, and ZK pipeline relate. Would help new contributors orient themselves — a single Mermaid diagram is enough.

### 6. Operator docs
No `docs/validator-setup.md` or `docs/delegator-guide.md` — needed before external contributors can register a validator or delegate stake without reading source code.

### 7. Automated CD pipeline
`ci.yml` runs tests/build only. No workflow deploys the API server or Explorer automatically on `main` push — manual push to Replit Deploy is the current process.

### 8. Rust/node binary release pipeline
Android APK has a release pipeline; the Rust validator/testnet-node binary does not. No `release-node.yml` building linux-amd64/arm64 binaries and attaching them to GitHub Releases on version tags.

### 9. Arbitrage: safety rails + execution path (intentionally out of scope so far)
The Bellman-Ford detector is wired up as **read-only detection + sizing only** — this was the explicit scope of the current task (display opportunities, don't act on them). Still not built, and would be needed before any autonomous execution: governance-controlled `max_arbitrage_size` parameter, a per-block rate limit on arbitrage trades, a negative-P&L circuit breaker, and the atomic multi-hop WASM contract execution path itself. No trades are currently ever placed automatically.

---

## 🔵 External / Infrastructure (out of Replit scope)

| Item | Notes |
|------|-------|
| Multi-region validator/sentry nodes | Requires external VMs / cloud infra (Hetzner suggested in README) |
| HA Postgres (replicas + failover + backups) | Requires managed DB service or self-hosted cluster |
| DDoS mitigation at the edge | Cloudflare or Hetzner DDoS protection, outside Replit |
| Full security / penetration audit | External firm, before public mainnet launch |
| iOS App Store distribution | Deliberately deferred — Android sideload first, per user preference |
| Play Store submission | Deferred until after private sideload feedback phase |
| Validator key rotation / HSM | Operational concern for live mainnet validators |

---

## Suggested priority order for next session

1. **#3** — Block reward format consistency (quick win, user-visible)
2. **#4** — Remaining raw loading-text spots (quick win, pattern already exists)
3. **#1** — Refactor `ContractDetail.tsx` / `AdminMultisig.tsx` onto generated hooks
4. **#2** — Wallet landing guidance for first-time users
5. **#6** — Operator docs (validator-setup.md, delegator-guide.md)
6. **#5** — Architecture diagram
7. **#7** — Automated CD pipeline
8. **#8** — Rust/node binary release pipeline
9. **#9** — Arbitrage governance safety rails (only if moving toward autonomous execution — not needed for the read-only detector already shipped)
