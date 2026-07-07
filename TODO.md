# Equilibrium — TODO & Gap Analysis
_Last updated: 2026-07-07 (session 2)_

---

## ✅ Completed This Sprint

| Area | What was done |
|------|--------------|
| **Auth** | Reconciled `ADMIN_KEY` / `ADMIN_API_KEY` mismatch; auth now accepts both; end-to-end verified (403 without key, 200 with correct key) |
| **Rate limiting** | HTTP `/api/blocks/submit`: per-IP sliding-window limit, prevHash:nonce replay rejection, ±300 s timestamp drift guard |
| **Stratum hardening** | Rate-limit key switched to TCP socket `remoteIp`; duplicate-share key includes `ntimeHex`; per-IP connection cap (max 8); correct Stratum error codes (20/22) |
| **Stratum metrics** | `GET /metrics/stratum` — Prometheus-format endpoint for connections, sessions, per-IP rejection counters; reports `enabled 0` gracefully when pool is off |
| **UTXO fee collection** | Fees no longer burned; `pendingUtxoFees` accumulator swept to block miner on every `addBlock()` path; rollback restores pool; `equilibrium_utxo_pending_fees` gauge added |
| **Block fee breakdown** | `GET /api/blocks/:hashOrHeight/fees` endpoint; "Miner Fee Breakdown" panel in Explorer block detail (coinbase + account-model fees + UTXO-model fees + total) |
| **Grafana stack** | Three dashboard JSONs (chain overview, validators/staking, stratum pool); `docker-compose.yml` spins up Prometheus + Grafana pre-wired; Grafana provisioning auto-loads datasource and dashboards — no manual import needed |
| **Android APK CI** | Full `android-apk.yml` CI workflow; `gradlew` + `gradle-wrapper.jar` added; keystore regenerated with `keytool` (OpenSSL 3.x compatibility fix); debug secret-logging step removed |
| **Postgres cold-start** | `start-postgres.sh` unsets Replit's injected `PGHOST`/`PGDATABASE`/`PGPASSWORD`; forces correct `PGUSER`; pins role-management calls to `-d postgres` — survives every container restart automatically |
| **Cold-boot auto-install (#20)** | `start-postgres.sh` now runs `pnpm install --frozen-lockfile` when `node_modules` is absent before attempting schema push — no manual intervention needed after a fresh clone or container reset |
| **Chain persistence on restart** | `loadBlocksFromDb()` recovers the longest contiguous block sequence from height 0 instead of resetting to genesis on any height gap or prevHash mismatch; bad suffix rows are pruned from the DB so the next restart converges cleanly |
| **TypeScript CI clean** | Fixed two typecheck errors introduced by a prior push: `Search.tsx` — added required `queryKey` option (TanStack Query v5) using generated `getGetBlock/TransactionQueryKey` helpers; `AdminMultisig.tsx` — cast `e.latencyMs as number` to satisfy `ReactNode` constraint. `pnpm run typecheck` now passes clean across all packages (150 TS + 28 Rust tests passing) |
| **Sequential workflow order** | `.replit` Project workflow changed from `mode = "parallel"` → `mode = "sequential"` with `waitForPort = 5432` on the Postgres step, eliminating the startup race between the API Server and the DB |

---

## 🔴 Critical / Correctness

These are bugs or gaps that affect correctness or security of the live chain.

### 1. Stratum proof validation (residual check) — **code only**
`stratum-server.ts` `onSubmit` accepts any share without verifying the submitted residual meets the current difficulty threshold. A malicious miner can submit garbage nonces.
- Add the same residual check used in `POST /api/blocks/submit` (`validateResidual`) inside `StratumServer.onSubmit`.
- File: `artifacts/api-server/src/stratum-server.ts`

### 2. CORS is wide open
`app.ts` calls `cors()` with no origin restriction — every browser tab on the internet can make credentialed requests to the API.
- Lock to known origins in production (`ALLOWED_ORIGINS` env var with a sensible dev default of `*`).
- File: `artifacts/api-server/src/app.ts`

### 3. No global API rate limiting
Individual submission routes are protected, but all read endpoints (`/api/blocks`, `/api/tx`, `/api/validators`, etc.) are completely unthrottled. A scraper or misconfigured client can DoS the node.
- Add a lightweight global rate-limit middleware (e.g. `express-rate-limit`) in `app.ts` — separate tiers for public read vs. write vs. admin endpoints.

### 4. Missing DB index on `contracts.deployer`
The contract list queries by deployer address on every page load. Without an index this is a full-table scan that will degrade as contracts accumulate.
- One-line Drizzle schema change + migration.
- File: `artifacts/api-server/src/db/schema.ts`

---

## 🟡 UI Bugs (visible in live screenshots)

### 5. "56y ago" timestamp bug — **all blocks**
Every block in the blocks list and dashboard shows "56 years ago". The age calculation is likely comparing against a wrong epoch baseline or treating a genesis timestamp differently.
- Audit the relative-time helper used in `BlockList` and `Dashboard`; confirm it handles the block `timestamp` field (Unix seconds) correctly.

### 6. Scientific notation everywhere
Multiple places render raw floats without formatting:
- Dashboard right Y-axis: `6e-9`, `4.5e-9`, `3e-9` (residual values)
- Governance page: `Mining Threshold: 1.00e-8`
- DEX pool price: `0.000010` (inconsistent precision)
- Blocks table: `Residual: 0.0000` (truncated to zero for small values)
- Add a shared `formatScientific(n, sigFigs)` utility that renders these as e.g. `1.0 × 10⁻⁸` or `< 0.000001` depending on context.

### 7. Nav bar truncation at 1280 px
"Contracts" is cut off to "Con…" at 1280 px wide. The nav doesn't scroll or collapse.
- Either reduce label text ("Contracts" → "Contract"), add a hamburger/overflow menu for narrower viewports, or switch to icon + label pairs that collapse to icon-only below a breakpoint.

### 8. Dashboard "Network Pressure" chart is confusing
The chart title says "Network Pressure" but it renders a dual-axis chart mixing mempool pressure (left, 0–4) and residual (right, 0–6e-9) with no legend labels explaining which line is which. A user has no idea what they're looking at.
- Add a visible legend, rename the chart to "Mempool Size & PoS Residual (Last 20 Blocks)", and label both axes.

### 9. Block reward display — misleading magnitude
Blocks list shows `50,000,000 EQU` as the reward. If this is the raw integer value (in the smallest denomination) it should be divided by the token precision before display. If it truly is 50M whole tokens per block, the UI should at minimum show it as `50M EQU` to avoid visual noise.
- Confirm intended denomination and apply consistent formatting across blocks list, block detail, and fee breakdown panel.

---

## 🟡 UI Enhancements (quality of life)

### 10. Skeleton loading states
Most pages show a plain "Loading…" string during data fetch, causing layout shift. High-traffic pages that need skeletons first:
- `Blocks` list (table skeleton rows)
- `Dashboard` stat cards
- `Validators` list
- `AddressDetail`

### 11. Error states with retry
Network failures silently leave the UI blank or show "Address not found" with no retry option. Add an `<ErrorBoundary>` + retry button wrapper around all async data panels.

### 12. Global search is non-functional / unclear
A search bar is visible in the nav layout but search behaviour for block height vs. tx hash vs. address is not clearly communicated. Either make it fully functional with routing logic for all three types, or remove it until it's ready.

### 13. Contracts and AdminMultisig are monolithic files
`ContractDetail.tsx` and `AdminMultisig.tsx` are 500+ line components. They also use raw `fetch()` instead of the generated React Query hooks, creating inconsistent loading/error state management.
- Extract sub-components (ABI call panel, storage inspector, proposal list) into their own files.
- Replace `fetch` calls with the generated `useGetContract`, etc. hooks so error/loading/refetch is handled uniformly.

### 14. Wallet page — empty state needs more guidance
The wallet landing page shows two large cards ("Create" / "Import") with no context about what Ed25519 means or what a private key looks like. First-time users will be confused.
- Add a short explainer: key format, where to back it up, and what operations require a connected wallet (DEX, staking, governance voting).

### 15. Validator detail — Fee Earnings tab shows empty for genesis validators
The new "Fee Earnings" tab on validator detail correctly shows zero (no txs yet), but an empty tab with no explanation looks broken. Add a proper empty state: "No fee-paying transactions have been included in blocks proposed by this validator yet."

### 16. DEX swap — output amount not shown before confirmation
The swap panel has "Amount in" but no "You will receive ≈ X" preview before hitting Swap. Users have no idea what the exchange rate is until after submitting.
- Compute and display the output amount and price impact live as the user types, using the constant-product formula.

---

## 🟢 Code / API enhancements

### 17. Validator setup & delegation operator docs
No documentation exists for: how to register a new validator, how to delegate stake, how to participate in governance. Needed before any external contributors onboard.
- Create `docs/validator-setup.md` and `docs/delegator-guide.md`.

### 18. Architectural diagram
No high-level diagram shows how the Rust core, TypeScript API server, Explorer, mobile app, Stratum server, and ZK proof pipeline relate to each other. A single Mermaid diagram in `docs/architecture.md` would help any new contributor orient themselves.

### 19. Automated CD pipeline
CI runs tests and builds the APK, but there is no automated deploy of the API server or Explorer to a production/staging environment. A manual push to Replit deployment is the current process.
- Consider a `deploy.yml` GitHub Action that runs on `main` push and calls the Replit Deploy API (or equivalent) for the web artifact.

### 20. Rust/node binary release artifacts
The Android APK has a CI release pipeline, but there is no equivalent for the Rust validator node binary. Operators who want to run a full node have no pre-built binary to download.
- Add a `release-node.yml` GitHub Action that builds `equilibrium` for linux-amd64 and linux-arm64 and attaches the binaries to GitHub Releases on version tags.

### 22. Validator Fee Earnings history endpoint
The block fee breakdown endpoint exists per-block, but there is no aggregated endpoint for "total fees earned by validator X over all time". The UI tab exists but has no data to back it.
- Add `GET /api/validators/:addr/earnings` that sums coinbase rewards + fee sweeps from all blocks where `miner === addr`.

---

## 🔵 External / Infrastructure (out of Replit scope)

| Item | Notes |
|------|-------|
| Multi-region validator nodes | Requires external VMs / cloud infra |
| HA Postgres (read replicas, failover) | Requires managed DB service |
| Full security / penetration audit | Recommend external firm before public launch |
| iOS distribution | TestFlight requires Apple Developer account; skip until after Android sideload proves stable |
| Play Store / App Store submission | After private sideload phase gathers feedback |
| Validator key rotation / HSM | Operational concern for mainnet validators |

---

## Priority order for next session

1. **#5** — Fix "56y ago" timestamp bug (highest user-visible impact, probably a one-liner)
2. **#7** — Fix nav bar overflow at 1280 px
3. **#1** — Stratum proof validation (correctness gap)
4. **#6** — Scientific notation formatting utility (affects multiple pages)
5. **#3** — Global API rate limiting (security)
6. **#2** — CORS lockdown (security)
7. **#10/#11** — Skeleton loaders + error states
8. **#8** — Dashboard chart labels
9. **#16** — DEX swap output preview
10. **#4** — `contracts.deployer` DB index
