# Equilibrium

A Rust-based Layer-1 blockchain with Proof-of-Stationarity consensus, mobile mining, ZK proofs, libp2p P2P networking, and a full TypeScript node stack with a real-time block explorer, self-custody browser wallet, and WASM smart contracts.

> **Status (July 2026):** Mainnet-readiness hardening complete in Replit. **173 tests pass** (28 Rust, 145 TypeScript). All critical security fixes applied: `REQUIRE_TX_SIGNATURES=true` enforced, Ed25519 batch verification wired into UTXO validation and block assembly, ADMIN_KEY/ADMIN_API_KEY mismatch fixed, HTTP + Stratum rate limiting with replay protection complete, UTXO fee collection wired (fees credited to miner, not burned), single `ADMIN_KEY` replaced with on-chain WASM M-of-N multisig. Remote load test: **149 TPS sustained, p95 70 ms, 9,009/9,009 txs accepted**. Android sideload APK CI live (GitHub Actions, signed, no Play Store). Grafana monitoring stack ready (`docs/grafana/`). Remaining Replit-actionable work is listed in the **What Needs To Be Done** section below.

---

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API node (port 8080, auto-mines every 15 s)
- `pnpm --filter @workspace/explorer run dev` — block explorer + wallet (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-server run test` — run 145 TypeScript tests
- `cd equilibrium && cargo test --lib` — run 28 Rust tests
- Rust testnet: `cd equilibrium && cargo run --bin testnet-node`
- Rust wallet CLI: `cd equilibrium && cargo run --bin wallet`
- `pnpm --filter @workspace/coinomics run generate-genesis [outputPath]` — write a fresh `genesis.json`

### After a container reset (recurring gotcha)

`node_modules` is NOT persisted across container resets. Run `pnpm install` first, then start workflows in order: **Postgres → API Server → Explorer**.

The Postgres workflow (`scripts/start-postgres.sh`) is fully idempotent — it unsets Replit's injected `PGHOST`/`PGDATABASE`/`PGPASSWORD`, forces the correct `PGUSER`, creates the runner role, pushes the schema, and grants table access on every boot. If it starts cleanly, the API Server workflow just works.

```bash
pnpm install
bash scripts/start-postgres.sh   # then restart API Server + Explorer workflows
```

---

## What Needs To Be Done

Everything below is actionable directly in Replit. See `TODO.md` for full detail, file paths, and notes.

### 🔴 Critical — correctness / security (do these first)

| # | Item | File |
|---|------|------|
| 1 | **Stratum proof validation** — `onSubmit` accepts any nonce without checking residual meets difficulty. Add the same `validateResidual` check used in `POST /api/blocks/submit`. | `artifacts/api-server/src/lib/stratum-server.ts` |
| 2 | ~~**CORS lockdown**~~ — ✅ Done. `ALLOWED_ORIGINS` env var (comma-separated valid http/https URLs). Unrecognised origins → 403. Server-to-server (no Origin header) always allowed. `credentials: true` only when ≥1 origin is configured. | `artifacts/api-server/src/app.ts` |
| 3 | ~~**Global API rate limiting**~~ — ✅ Done. `express-rate-limit`: read tier 300 req/min, write tier 20 req/min (auto-skips GET/HEAD/OPTIONS). | `artifacts/api-server/src/app.ts` |
| 4 | ~~**`contracts.deployer` DB index**~~ — ✅ Done. Both `contracts_deployer_idx` (btree on deployer) and `contracts_deployed_at_idx` (btree on deployed_at) added and pushed to DB. Route also supports `?deployer=` filter + newest-first sort. | `lib/db/src/schema/contracts.ts` |

### 🟡 UI bugs — visible in the live Explorer right now

| # | Item | File |
|---|------|------|
| 5 | **"56y ago" on every block** — age formatter miscalculates block timestamps. Audit the relative-time helper. | Explorer timestamp utility |
| 6 | **Nav overflow at 1280 px** — "Contracts" truncates to "Con…". Add overflow menu or shorten labels. | Explorer nav component |
| 7 | **Scientific notation everywhere** — residual shows `6e-9` on dashboard, governance shows `1.00e-8`, DEX price shows `0.000010`. Add a shared `formatScientific()` utility. | Dashboard, Governance, Dex pages |
| 8 | **Dashboard chart has no legend** — dual Y-axis (mempool + residual) with no labels. Rename chart and add axis labels. | `artifacts/explorer/src/pages/Dashboard.tsx` |
| 9 | **DEX swap shows no output preview** — no "you will receive ≈ X" before the user confirms. Compute live from constant-product formula. | `artifacts/explorer/src/pages/Dex.tsx` |

### 🟡 UI polish

| # | Item |
|---|------|
| 10 | **Skeleton loading states** — raw "Loading…" text on blocks list, dashboard stats, validators, address detail. |
| 11 | **Error states with retry** — network failures leave the UI blank; add `<ErrorBoundary>` + retry button. |
| 12 | **Wallet landing page guidance** — no explanation of what Ed25519 / a private key means for first-time users. |
| 13 | **Validator Fee Earnings empty state** — tab exists but appears broken when no blocks have been proposed yet. |
| 14 | **Refactor `ContractDetail.tsx` / `AdminMultisig.tsx`** — both are 500+ line monoliths using raw `fetch()` instead of generated React Query hooks. |

### 🟢 Enhancements

| # | Item | File |
|---|------|------|
| 15 | **Validator earnings aggregate endpoint** — `GET /api/validators/:addr/earnings` summing coinbase + fee sweeps; the UI tab exists but has no aggregate backend. | `artifacts/api-server/src/routes/validators.ts` |
| 16 | **`pnpm install` auto-check on reset** — add startup check in `start-postgres.sh` or `.replit` so a fresh container doesn't silently break. | `scripts/start-postgres.sh` |
| 17 | **Architectural diagram** — `docs/architecture.md` with a Mermaid diagram showing Rust core ↔ TS API ↔ Explorer ↔ Mobile ↔ Stratum ↔ ZK pipeline. | New file |
| 18 | **Operator docs** — `docs/validator-setup.md` and `docs/delegator-guide.md` for external contributors. | New files |
| 19 | **Block reward denomination** — confirm `50,000,000 EQU` per block is the right unit (not raw integer pre-scaling) and apply consistent formatting (`50M EQU`) everywhere. | Explorer block display |

### 🔵 External / out of Replit scope

| Item | Notes |
|------|-------|
| Multi-region validator nodes | Requires external VMs / cloud infra |
| HA Postgres (replicas + failover) | Requires managed DB service |
| Full security / penetration audit | External firm before public launch |
| iOS distribution | Skip until Android sideload proves stable |
| Rust/node binary release pipeline | CI for linux-amd64 / linux-arm64 release artifacts |
| Automated CD for API + Explorer | Deploy to Replit production on `main` push |

---

## Stack

- Monorepo: pnpm workspaces, Node.js 20, TypeScript 5.9
- Rust core: `ed25519-dalek`, `libp2p` (full), `ark-snark`, `sha2`, `serde`
- API node: Express 5, in-memory chain state + Postgres persistence (Drizzle ORM)
- Explorer/Wallet: React 18, Vite 7, Tailwind CSS v4, React Query, Wouter, Recharts
- Wallet crypto: `@noble/ed25519` v3, `@scure/bip39`, `@scure/bip32`, Web Crypto API
- API contract: OpenAPI 3.1 → Orval codegen → `@workspace/api-client-react` + `@workspace/api-zod`
- WASM VM: Node built-in `WebAssembly` — deploy, call, storage get/set, gas accounting
- Monitoring: Prometheus exposition format, Grafana 11, `docs/grafana/docker-compose.yml`
- Mobile: Kotlin + JNI (Android APK CI via `android-apk-ci.yml`), Swift Package (iOS)

---

## Where Things Live

- `equilibrium/` — Rust core library + testnet binary + wallet CLI + Android JNI bridge
- `genesis.json` — finalised mainnet genesis: 7 allocations, 95M EQU + 4 validators × 5M bonded = 100M total supply
- `scripts/start-postgres.sh` — idempotent DB bootstrap (unsets Replit env vars, creates role, pushes schema, grants access)
- `scripts/src/generate-genesis.ts` — generates real Ed25519 keypairs → writes `genesis.json` + `validator-keys.json`
- `scripts/generate-android-keystore.sh` — keytool-first PKCS12 keystore (OpenSSL 3.x `-legacy` fallback)
- `artifacts/api-server/src/chain/` — TypeScript chain engine: `state.ts`, `crypto.ts`, `index.ts` (auto-miner), `governance.ts`, `wasm.ts`, `persistence.ts`, `zkproof.ts`, `zk-encoding.ts`
- `artifacts/api-server/src/lib/stratum-server.ts` — Stratum v1 TCP mining pool + metrics + per-IP rate limiting
- `artifacts/api-server/src/lib/submission-guard.ts` — `RateLimiter` (sliding window) + `ReplaySet` (bounded LRU) for HTTP + Stratum
- `artifacts/api-server/src/routes/` — Express route handlers (blocks, tx, validators, staking, dex, governance, contracts, evm, faucet, metrics, stratum-metrics, mobile)
- `artifacts/api-server/src/__tests__/` — test suite: `chain.unit.test.ts` (40), `api.integration.test.ts` (25), `contracts.integration.test.ts` (80)
- `artifacts/explorer/src/pages/` — Dashboard, Blocks, BlockDetail, TxDetail, AddressDetail, Mempool, Network, Validators, ValidatorDetail, Governance, Faucet, Contracts, ContractDetail, Dex, Staking, AdminMultisig
- `artifacts/explorer/src/wallet/` — browser wallet (context.tsx state manager, crypto.ts key ops)
- `lib/api-spec/openapi.yaml` — source-of-truth API contract
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit manually)
- `lib/coinomics/src/` — mainnet coinomics: `reward.ts`, `genesis.ts`, `staking.ts`, `slashing.ts`
- `docs/grafana/` — `docker-compose.yml` + `prometheus.yml` + 3 dashboard JSONs + Grafana provisioning YAML — one `docker compose up -d` spins up the full monitoring stack
- `docs/mobile-apk-release.md` — Android APK signing, CI, and sideload distribution guide
- `android-apk-ci.yml` — copy to `.github/workflows/android-apk.yml` to activate APK CI
- `scripts/load-test.js` — k6 load test (50 VUs, real Ed25519 signed txs); 149 TPS over HTTPS

---

## Architecture Decisions

- **Postgres-backed persistence** — `blocks`, `transactions`, `validators`, `contracts` tables via Drizzle ORM. `initChain()` loads from Postgres on startup (falls back to genesis if empty). `scripts/start-postgres.sh` unsets Replit's injected env vars before any psql call — this was the root cause of cold-start failures and is now fixed permanently.
- **Contract-first API** — OpenAPI spec lives in `lib/api-spec/openapi.yaml`; client hooks and Zod schemas are generated by Orval. Never hand-write API types in the client.
- **Address derivation** — `SHA-256(raw_pubkey_bytes)[..20]` rendered as 40 hex chars. Matches Rust's `address_from_pubkey`. The explorer wallet hashes **raw bytes** (not the UTF-8 hex string) — critical distinction; wrong encoding produces different addresses for the same keypair.
- **`@noble/ed25519` v3 API** — use `ed.utils.randomSecretKey()` (not `randomPrivateKey`), `ed.etc.hexToBytes()` (not `ed.utils.hexToBytes`), and pass `Uint8Array` (not hex strings) to `signAsync`. All key ops use the async API.
- **Coinomics wired into live block production** — `state.ts` imports `@workspace/coinomics` directly; `distributeBlockReward()`/`payValidatorReward()` split every coinbase and participation reward.
- **WASM VM validation** — `WasmVM.deploy()` calls `WebAssembly.compile()` (not `validate()`) to reject invalid bytecode — `compile()` throws, `validate()` only returns a boolean.
- **Fixed-point residuals** — residuals stored as `residualFp` (i64 scaled 1e18); `reorganize()` in `state.ts` uses BigInt comparison throughout; eliminates float non-determinism in fork choice. Rust `BlockHeader` uses `i64` for the same reason.
- **Fee collection, both balance models** — account-model tx fees credited to `block.miner` in `addBlock()`. UTXO-model fees accrue in `ChainState.pendingUtxoFees` (set at `/utxo/spend` time) and swept to `block.miner` on the next `addBlock()`; `rollbackToHeight()` undoes the swept UTXO and restores the pool on reorg. No fees burned in either model.
- **Admin auth** — `POST /validators/:addr/slash` accepts both `ADMIN_KEY` and `ADMIN_API_KEY` env var names. On-chain WASM M-of-N multisig supersedes the single key when `ADMIN_MULTISIG_ADDRESS` is set.
- **Stratum security** — rate-limit keyed by TCP socket `remoteIp` (not self-reported miner address); duplicate-share key includes `ntimeHex`; per-IP connection cap 8; error codes 20 (rate-limit/drift) and 22 (duplicate).
- **Android keystore** — `scripts/generate-android-keystore.sh` uses `keytool` first (Java-native PKCS12, always AGP-compatible); falls back to `openssl pkcs12 -legacy` (forces 3DES/RC2 — OpenSSL 3.x default AES-256-CBC is not readable by Android Gradle Plugin).

---

## Mainnet Readiness Checklist

| # | Item | Status |
|---|------|--------|
| 1 | Genesis block finalised (real keypairs, 100M supply) | ✅ Done |
| 2 | Fixed-point residuals in Rust (i64, no f64) | ✅ Done |
| 3 | Governance vote signature tests | ✅ Done |
| 4 | Postgres persistence (schema, grants, idempotent startup) | ✅ Done |
| 5 | CI/CD pipeline (typecheck + TS tests + Rust tests) | ✅ Done |
| 6 | Smart contract DB persistence | ✅ Done |
| 7 | WAT→WASM deploy UI in Explorer | ✅ Done |
| 8 | Smart contract test suite | ✅ Done |
| 9 | Remote load test (149 TPS, p95 70 ms, 9,009/9,009 accepted) | ✅ Done |
| 10 | Enforced tx signature requirement (`REQUIRE_TX_SIGNATURES=true`) | ✅ Done |
| 11 | Ed25519 batch verification (UTXO + block assembly) | ✅ Done |
| 12 | Native WASM multisig replacing single `ADMIN_KEY` | ✅ Done |
| 13 | ADMIN_KEY / ADMIN_API_KEY mismatch fixed (auth now works) | ✅ Done |
| 14 | HTTP rate limiting + replay protection on block submit | ✅ Done |
| 15 | Stratum server hardening (socket IP, ntimeHex, connection cap, error codes) | ✅ Done |
| 16 | UTXO fee collection wired (credited to miner, not burned) | ✅ Done |
| 17 | Miner fee breakdown endpoint + Explorer panel | ✅ Done |
| 18 | Validator fee earnings tab | ✅ Done |
| 19 | Stratum metrics endpoint (`/metrics/stratum`) | ✅ Done |
| 20 | Grafana dashboards + docker-compose monitoring stack | ✅ Done — `docs/grafana/` |
| 21 | Android APK CI (signed, sideload, in-app update check) | ✅ Done — `android-apk-ci.yml` |
| 22 | Postgres cold-start fix (Replit env var injection) | ✅ Done |
| 23 | Android keystore OpenSSL 3.x compatibility | ✅ Done |
| 24 | Stratum proof validation (residual check in onSubmit) | ⏳ Replit |
| 25 | CORS lockdown (`ALLOWED_ORIGINS` env var) | ✅ Done |
| 26 | Global API rate limiting (read + write tiers) | ✅ Done |
| 27 | `contracts.deployer` DB index | ⏳ Replit |
| 28 | Multi-region nodes, HA Postgres, security audit | ⏳ External |
| 29 | Operator docs, iOS release | ⏳ External |

---

## Product

- **Block explorer** at `/`: real-time chain dashboard, block/tx/address drill-down, mempool monitor, peer network view, validator set + delegators, governance proposals, **miner fee breakdown per block**
- **Governance** at `/governance`: submit and vote on proposals (text or parameter-change), live quorum/tally bars, chain parameters panel, auto-executes on passage; votes are Ed25519-signed and server-verified
- **Faucet** at `/faucet`: drip 1,000 EQU to any address, 1 h cooldown per address, live cooldown status
- **Browser wallet** at `/wallet`: self-custody Ed25519, BIP-39 mnemonic, raw keypair, private key import, AES-256-GCM keystore, Ledger via WebHID, m-of-n multisig, transaction signing and broadcast
- **Smart contracts** at `/contracts`: WAT editor with in-browser `wabt` compile, ABI JSON editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage key/value viewer, bytecode hash
- **DEX** at `/dex`: constant-product AMM (0.3% fee), swap, add liquidity, price quotes, swap history, per-address positions
- **Rust core**: Proof-of-Stationarity consensus, Lagrangian optimizer miner, Ed25519 wallet, ZK proof (Groth16/BN254), libp2p P2P, mobile FFI exports; 28 unit tests passing

---

## Gotchas

- Do not run `pnpm dev` at workspace root — run per-package with `--filter` or use the workflow buttons.
- `@noble/ed25519` v2 freezes `ed.etc` — never assign `sha512Sync`; use async functions only.
- The Rust crate includes `libp2p` with `features = ["full"]` which downloads 470+ crates on first build — expect `cargo build` to take several minutes on a cold cache.
- After editing `lib/api-spec/openapi.yaml`, always run codegen before touching client code: `pnpm --filter @workspace/api-spec run codegen`.
- Governance paths in openapi.yaml must go inside the `paths:` section (before `components:`), not appended to the end of the file.
- Rust unit tests: `cd equilibrium && cargo test --lib` (28 tests: wallet + stationary_solver + consensus).
- Load test: `k6 run scripts/load-test.js -e BASE_URL=https://<your-repl>.replit.dev` — k6 binary must be re-downloaded after each container reset (not in PATH by default).
- `WebAssembly.compile()` throws on invalid WASM; `WebAssembly.validate()` only returns a boolean and never throws — always use `compile()` for fail-fast rejection.
- Every container reset loses `node_modules`. Run `pnpm install` if needed, then restart all three workflows (Postgres → API Server → Explorer) in that order.
- Admin multisig (`chain/multisig.ts`, `chain/contracts/multisig.wat`) is opt-in: set `ADMIN_MULTISIG_OWNERS` (comma-separated 40-hex addresses) + `ADMIN_MULTISIG_THRESHOLD` to deploy fresh on next boot; then set `ADMIN_MULTISIG_ADDRESS` to the logged address to keep it stable across restarts. Without these, `/validators/:addr/slash` falls back to the legacy `ADMIN_KEY` / `ADMIN_API_KEY` header check (both accepted).
- WAT `(data ...)` string literals only occupy their exact byte length — never assume a padded/round size when using that length elsewhere; an off-by-one silently corrupts downstream buffers with no error, just failed signature checks.
- Android keystore: always generate with `scripts/generate-android-keystore.sh` (uses `keytool` first). Never use raw `openssl pkcs12 -export` without `-legacy` — OpenSSL 3.x defaults to AES-256-CBC which Android Gradle Plugin cannot decrypt ("Given final block not properly padded").
- The `Explorer` workflow (port 5000) may conflict with `artifacts/explorer: web` if both are started. The authoritative one is `artifacts/explorer: web` — the top-level `Explorer` workflow is the duplicate that fails. Ignore its failure in logs.
- Similarly, `artifacts/api-server: API Server` will fail with EADDRINUSE if the main `API Server` workflow is already running on port 8080. The main `API Server` workflow (with `DATABASE_URL` set) is the authoritative one.

---

## Pointers

- See `README.md` for the full project overview, API reference, architecture, and remaining work
- See `TODO.md` for the prioritised gap analysis with file-level pointers for every open item
- See `docs/zk-circuit.md` for the Groth16 circuit spec and `fpEncode`/`blockHashToFields` encoding rules
- See `docs/incentive-model.md` for the miner incentive analysis
- See `docs/grafana/README.md` for Prometheus + Grafana dashboard setup — edit `prometheus.yml` target then `docker compose up -d`
- See `docs/mobile-apk-release.md` for the Android sideload APK release process (signing, CI secrets, distribution)
- See `android-apk-ci.yml` at repo root — copy to `.github/workflows/android-apk.yml` to activate APK CI (cannot push directly from Replit)

## User Preferences

- iOS store submission is deliberately skipped for now — Android sideload first, gather contributors, fix bugs, then revisit store submission later
- Mobile store release via sideload only (no Play Store / App Store fees during private testing phase)
- CI workflow files are authored at repo root (`android-apk-ci.yml`) because Replit cannot push directly to `.github/workflows/` — user copies them manually to GitHub
