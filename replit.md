# Equilibrium

A Rust-based Layer-1 blockchain with Proof-of-Stationarity consensus, mobile mining, ZK proofs, libp2p P2P networking, and a full TypeScript node stack with a real-time block explorer, self-custody browser wallet, WASM smart contracts, and a native DEX arbitrage detector.

> **Status (July 9, 2026):** Mainnet-readiness hardening complete in Replit. **197 TypeScript + 28 Rust tests pass** (6 test files: chain.unit, api.integration, contracts.integration, multisig.integration, models.integration, arbitrage.integration). All critical security fixes applied: `REQUIRE_TX_SIGNATURES=true` enforced, Ed25519 batch verification wired into UTXO validation and block assembly, ADMIN_KEY/ADMIN_API_KEY mismatch fixed, HTTP + Stratum rate limiting with replay protection complete, UTXO fee collection wired (fees credited to miner, not burned), single `ADMIN_KEY` replaced with on-chain WASM M-of-N multisig. Remote load test: **149 TPS sustained, p95 70 ms, 9,009/9,009 txs accepted**. Android sideload APK CI live (GitHub Actions, signed, no Play Store). Grafana monitoring stack ready (`docs/grafana/`). ModelRegistry + Arbitrage WASM contracts deployed and live. `LIMITATIONS.md` created. `ci.yml` updated to include variational-ai Rust tests and all 6 TS test files. See `LIMITATIONS.md` for known design constraints (minProfit advisory, in-memory DEX pools, missing slash_account/transfer host functions, inference attestation scope). **Verified against running code on 2026-07-09.**
>
> **CI fix (July 9, 2026):** `variational-ai-export-onnx` (the real, non-stub ONNX exporter using `prost`), the `solveBlock` JNI bridge, `VariationalAI.kt`/`ThermalGuard.kt`, and `scripts/convert_to_hexagon.py` from the mobile AI-mining draft were already implemented in this repo — confirmed by direct inspection, not just docs. The GitHub Actions `cargo clippy --all-targets -- -D warnings` failure was two unrelated clippy lints in `export_onnx.rs` (an empty line after a doc comment, and several `uninlined_format_args`), now fixed; `cargo clippy --all-targets -- -D warnings` passes clean in `variational-ai/`.
>
> **ModelRegistry inference attestation (July 9, 2026):** rather than the draft's literal ERC-7992/Groth16/EIP-165 sketch, `ModelRegistry` gained `submit_inference_attestation` / `get_inference_status` / `get_capabilities` — an Ed25519-signed "who claims this output for this input" receipt, reusing the `verify_owner_sig` host import already proven in the multisig contract, plus a capability bitmask in the spirit of `supportsInterface` (see `LIMITATIONS.md` §1b for exactly what this is and isn't). Exposed via `POST/GET /api/models/:id/inference-proof|inference-status`. The much larger DeepProve/IBC v2/zQR ideas, and true zkML correctness proofs (a per-model witness generator + SNARK circuit), remain **out of scope** — a deliberate, scoped follow-up requiring dedicated cryptographic engineering, not a quick add-on.

---

## Run & Operate

- `DATABASE_URL=postgresql://runner@127.0.0.1:5432/equilibrium PORT=8080 pnpm --filter @workspace/api-server run dev` — API node (port 8080, auto-mines every 15 s; omitting `DATABASE_URL` runs in-memory mode — no persistence)
- `pnpm --filter @workspace/explorer run dev` — block explorer + wallet (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/api-server run test` — run 169 TypeScript tests
- `cd equilibrium && cargo test --lib` — run 28 Rust tests
- Rust testnet: `cd equilibrium && cargo run --bin testnet-node`
- Rust wallet CLI: `cd equilibrium && cargo run --bin wallet`
- `pnpm --filter @workspace/coinomics run generate-genesis [outputPath]` — write a fresh `genesis.json`
- `pnpm --filter @workspace/scripts run seed-arbitrage-demo` — seed a synthetic mispriced pool so the arbitrage panel has a real cycle to show (dev-only, in-memory, resets on next restart)

### After a container reset (recurring gotcha)

`node_modules` is NOT persisted across container resets. Run `pnpm install` first, then start workflows in order: **Postgres → API Server → Explorer**.

The Postgres workflow (`scripts/start-postgres.sh`) is fully idempotent — it unsets Replit's injected `PGHOST`/`PGDATABASE`/`PGPASSWORD`, forces the correct `PGUSER`, creates the runner role, pushes the schema, and grants table access on every boot. If it starts cleanly, the API Server workflow just works.

```bash
pnpm install
bash scripts/start-postgres.sh   # then restart API Server + Explorer workflows
```

---

## What Needs To Be Done

Everything below is actionable directly in Replit. See `TODO.md` for full detail, file paths, and priority order. This list was verified directly against the running code on 2026-07-08 — anything not listed here is done.

### 🟡 UI polish

| # | Item | File |
|---|------|------|
| 1 | **`ContractDetail.tsx` / `AdminMultisig.tsx` are still monolithic** — 427 and 836 lines, both still use raw `fetch()` (10–11 call sites each) instead of generated React Query hooks. | `artifacts/explorer/src/pages/ContractDetail.tsx`, `AdminMultisig.tsx` |
| 2 | **Wallet landing guidance is minimal** — only a one-line description; no explanation of Ed25519/private keys/mnemonics for first-time users. | `artifacts/explorer/src/pages/wallet/WalletHome.tsx` |
| 3 | **Block reward format is inconsistent** — `Blocks.tsx` uses `formatCompact()` ("50M EQU"), `BlockDetail.tsx` uses `formatAmount()` ("50,000,000 EQU") in two places. Pick one convention. | `Blocks.tsx`, `BlockDetail.tsx` |
| 4 | **A few isolated raw "Loading…" strings remain** — Dashboard chart area, ValidatorDetail delegators table, Dex pools table still show plain text instead of the skeleton pattern used elsewhere. | `Dashboard.tsx`, `ValidatorDetail.tsx`, `Dex.tsx` |

### 🟢 Docs & ops enhancements

| # | Item | File |
|---|------|------|
| 5 | **Architectural diagram** — `docs/architecture.md` with a Mermaid diagram showing Rust core ↔ TS API ↔ Explorer ↔ Mobile ↔ Stratum ↔ ZK ↔ arbitrage pipeline. | New file |
| 6 | **Operator docs** — `docs/validator-setup.md` and `docs/delegator-guide.md` for external contributors. | New files |
| 7 | **Automated CD** — `ci.yml` runs tests/build only; no workflow auto-deploys the API server or Explorer on `main` push. | New workflow file |
| 8 | **Rust/node binary release pipeline** — Android APK has a release pipeline; the Rust validator/testnet-node binary does not (no linux-amd64/arm64 GitHub Release artifacts). | New workflow file |

### 🟢 Arbitrage follow-on (only needed if moving toward autonomous execution)

| # | Item | Notes |
|---|------|-------|
| 9 | **Governance safety rails + execution path** — detector is intentionally read-only/display-only today (this task's scope). Autonomous execution would need a governance-controlled `max_arbitrage_size` param, a per-block rate limit, a negative-P&L circuit breaker, and the atomic multi-hop WASM execution path itself. No trades are ever placed automatically right now. | `variational-ai/src/arbitrage.rs`, new WASM contract |

### 🔵 External / out of Replit scope

| Item | Notes |
|------|-------|
| Multi-region validator nodes | Requires external VMs / cloud infra |
| HA Postgres (replicas + failover) | Requires managed DB service |
| Full security / penetration audit | External firm before public launch |
| iOS distribution | Skip until Android sideload proves stable |
| DDoS mitigation at the edge | Cloudflare or Hetzner DDoS protection, outside Replit |

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
- Arbitrage detection: Rust Bellman-Ford negative-cycle detector (`variational-ai/src/arbitrage.rs`) spawned as a CLI subprocess from the API server, same pattern as the residual verifier

---

## Where Things Live

- `equilibrium/` — Rust core library + testnet binary + wallet CLI + Android JNI bridge
- `variational-ai/` — Rust crate: NTK/logistic/MLP solvers, determinism harness, and `arbitrage.rs` (Bellman-Ford currency-arbitrage detector); binaries `variational-ai-cli` (residual verify) and `variational-ai-arbitrage-cli` (opportunity scan) are copied into `artifacts/api-server/` for the TS bridge
- `genesis.json` — finalised mainnet genesis: 7 allocations, 95M EQU + 4 validators × 5M bonded = 100M total supply
- `scripts/start-postgres.sh` — idempotent DB bootstrap (unsets Replit env vars, creates role, pushes schema, grants access)
- `scripts/src/generate-genesis.ts` — generates real Ed25519 keypairs → writes `genesis.json` + `validator-keys.json`
- `scripts/src/seed-arbitrage-demo.ts` — dev-only script that seeds a synthetic mispriced WBTC-USDC pool via `POST /api/dex/pools/seed-arbitrage-demo` so the arbitrage panel has a real cycle to display
- `scripts/generate-android-keystore.sh` — keytool-first PKCS12 keystore (OpenSSL 3.x `-legacy` fallback)
- `artifacts/api-server/src/chain/` — TypeScript chain engine: `state.ts` (includes `createPool()` for the arbitrage demo seed), `crypto.ts`, `index.ts` (auto-miner), `governance.ts`, `wasm.ts`, `persistence.ts`, `zkproof.ts`, `zk-encoding.ts`
- `artifacts/api-server/src/variational-ai/bridge.ts` — spawns the Rust CLI binaries; resolves binary paths via `process.cwd()` first with `fs.existsSync` fallbacks (see Architecture Decisions — esbuild bundling bug)
- `artifacts/api-server/src/lib/stratum-server.ts` — Stratum v1 TCP mining pool + metrics + per-IP rate limiting
- `artifacts/api-server/src/lib/submission-guard.ts` — `RateLimiter` (sliding window) + `ReplaySet` (bounded LRU) for HTTP + Stratum
- `artifacts/api-server/src/routes/` — Express route handlers (blocks, tx, validators, staking, dex, arbitrage, governance, contracts, evm, faucet, metrics, stratum-metrics, mobile)
- `artifacts/api-server/src/__tests__/` — test suite: `chain.unit.test.ts`, `api.integration.test.ts`, `contracts.integration.test.ts`, `multisig.integration.test.ts`, `models.integration.test.ts`, `arbitrage.integration.test.ts` (193 tests total)
- `artifacts/explorer/src/pages/` — Dashboard, Blocks, BlockDetail, TxDetail, AddressDetail, Mempool, Network, Validators, ValidatorDetail, Governance, Faucet, Contracts, ContractDetail, Dex (includes the Arbitrage Opportunities panel), Staking, AdminMultisig
- `artifacts/explorer/src/wallet/` — browser wallet (context.tsx state manager, crypto.ts key ops)
- `lib/api-spec/openapi.yaml` — source-of-truth API contract, includes the `arbitrage` tag / `ArbitrageOpportunity` schema
- `lib/api-client-react/src/generated/` — generated React Query hooks (do not edit manually), includes `useGetArbitrageOpportunities`
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
- **Arbitrage detection is read-only** — `GET /api/arbitrage/opportunities` scans live DEX pool reserves through the Rust Bellman-Ford detector and reports cycles + optimal sizing; it never executes a trade. Any move toward autonomous execution needs the governance/rate-limit/circuit-breaker work tracked in `TODO.md`.
- **esbuild + `import.meta.url` bundling bug** — any module resolving a sibling binary path via `__dirname` from `import.meta.url` breaks once esbuild bundles multiple source files into one output file, because every module then sees the *bundle's own* URL (not its original source path), shifting the effective directory depth. This silently broke both CLI-binary path lookups in `bridge.ts`/`wasm.ts` in production (the `dev`/`start` scripts always run the bundled `dist/index.mjs`, so it was a live bug, not just a dev/prod discrepancy). Fixed by resolving through `process.cwd()` first with `fs.existsSync` fallbacks — apply the same pattern to any future CLI-bridge module.

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
| 18 | Validator fee earnings tab + aggregate endpoint | ✅ Done |
| 19 | Stratum metrics endpoint (`/metrics/stratum`) | ✅ Done |
| 20 | Grafana dashboards + docker-compose monitoring stack | ✅ Done — `docs/grafana/` |
| 21 | Android APK CI (signed, sideload, in-app update check) | ✅ Done — `android-apk-ci.yml` |
| 22 | Postgres cold-start fix (Replit env var injection) | ✅ Done |
| 23 | Android keystore OpenSSL 3.x compatibility | ✅ Done |
| 24 | Stratum proof validation (residual check in onSubmit) | ✅ Done |
| 25 | CORS lockdown (`ALLOWED_ORIGINS` env var) | ✅ Done |
| 26 | Global API rate limiting (read + write tiers) | ✅ Done |
| 27 | `contracts.deployer` DB index | ✅ Done |
| 28 | Read-only DEX arbitrage detector + Explorer panel | ✅ Done — see `TODO.md` #9 for the (out-of-scope) execution path |
| 29 | `ContractDetail.tsx` / `AdminMultisig.tsx` refactor onto generated hooks | ⏳ Open — see `TODO.md` #1 |
| 30 | Architecture diagram, operator docs | ⏳ Open — see `TODO.md` #5–6 |
| 31 | Automated CD, Rust binary release pipeline | ⏳ Open — see `TODO.md` #7–8 |
| 32 | Multi-region nodes, HA Postgres, security audit | ⏳ External |

---

## Product

- **Block explorer** at `/`: real-time chain dashboard, block/tx/address drill-down, mempool monitor, peer network view, validator set + delegators, governance proposals, **miner fee breakdown per block**
- **Governance** at `/governance`: submit and vote on proposals (text or parameter-change), live quorum/tally bars, chain parameters panel, auto-executes on passage; votes are Ed25519-signed and server-verified
- **Faucet** at `/faucet`: drip 1,000 EQU to any address, 1 h cooldown per address, live cooldown status
- **Browser wallet** at `/wallet`: self-custody Ed25519, BIP-39 mnemonic, raw keypair, private key import, AES-256-GCM keystore, Ledger via WebHID, m-of-n multisig, transaction signing and broadcast
- **Smart contracts** at `/contracts`: WAT editor with in-browser `wabt` compile, ABI JSON editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage key/value viewer, bytecode hash
- **DEX** at `/dex`: constant-product AMM (0.3% fee), swap, add liquidity, price quotes, swap history, per-address positions, **live arbitrage opportunity panel** (read-only Bellman-Ford cycle detection over live pool reserves, 15s refresh)
- **Rust core**: Proof-of-Stationarity consensus, Lagrangian optimizer miner, Ed25519 wallet, ZK proof (Groth16/BN254), libp2p P2P, mobile FFI exports, Bellman-Ford arbitrage detector; 28 unit tests passing

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
- Any Node module that resolves a sibling binary path via `__dirname` from `import.meta.url` will resolve incorrectly once esbuild bundles it — see Architecture Decisions above. Always resolve through `process.cwd()` first with an `fs.existsSync` fallback chain.
- New DEX pools created outside of `genesis.json` (e.g. via `createPool()` / the arbitrage demo seed route) are in-memory only and do not survive a server restart — pools are always rebuilt from `genesis.json`'s `dex_pools` array on boot, not from Postgres.

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
- Keep `replit.md`, `README.md`, and `TODO.md` reconciled against actual running code, not just carried forward from a prior session's notes — verify claims with a quick grep/read before trusting a "done"/"open" status from an existing doc
