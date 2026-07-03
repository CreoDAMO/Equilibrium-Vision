# Equilibrium — TODO

Prioritized task list. P0 items are verified, reproducible problems (found by running `pnpm typecheck` and attempting a Rust build against the current commit) — fix these before any demo, deploy, or new feature work.

---

## P0 — Broken right now

### 1. Wallet crypto uses a dead `@noble/ed25519` v2 API
`package.json` pins `@noble/ed25519@^3.1.0`, but `artifacts/explorer/src/wallet/crypto.ts` still calls the v2 surface. This throws at runtime, not just at typecheck.

- [ ] Line 22: `ed.utils.randomPrivateKey()` → `ed.utils.randomSecretKey()`
- [ ] Line 31: `ed.utils.hexToBytes(privHex)` → `ed.etc.hexToBytes(privHex)`
- [ ] Line 237: `ed.utils.hexToBytes(privateKeyHex)` → `ed.etc.hexToBytes(privateKeyHex)`
- [ ] Line 257: `ed.utils.hexToBytes(signature)` → `ed.etc.hexToBytes(signature)`
- [ ] Line 259: `ed.utils.hexToBytes(signerPubKey)` → `ed.etc.hexToBytes(signerPubKey)`
- [ ] Grep the whole file for any other `ed.utils.*` call and cross-check against the installed v3 `index.d.ts` before considering this closed
- [ ] Manually test: create raw keypair, import from hex, create multisig, sign + verify multisig — all currently broken

### 2. Undefined variable in UTXO spend route
`artifacts/api-server/src/routes/utxo.ts`, `POST /api/utxo/spend` handler (~line 98/101) references `cs.utxoSet` but never assigns `const cs = chainState`, unlike every other handler in the same file.

- [ ] Add `const cs = chainState;` at the top of the `/utxo/spend` handler
- [ ] Add a regression test so this specific class of bug (works in every handler but one) doesn't recur

### 3. `pnpm run build` fails typecheck
Confirmed by running `pnpm install && pnpm run typecheck` against a clean checkout.

**`api-server`:**
- [ ] `chain/wasm.ts` — add `"lib": ["ES2022"]` isn't enough; add `"dom"` to `tsconfig.json`'s `lib`, or install `@types/node`'s WebAssembly types explicitly, so the global `WebAssembly` namespace resolves
- [ ] `routes/contracts.ts` (lines 52, 63, 75, 100) and `routes/utxo.ts` (lines 28, 47, 78) — several handlers `return res.status(400)...` on the error path but fall through without `return` on success, violating `noImplicitReturns`. Add explicit `return` before the trailing `res.json(...)` in each handler, or refactor to a single return point.

**`explorer`:**
- [ ] `wallet/ledger.ts` — `HIDDevice`, `USBDevice`, `HIDInputReportEvent` are not resolving. Confirm whether the installed TypeScript version ships WebHID/WebUSB ambient types under `dom`; if not, add `@types/w3c-web-usb` and `@types/w3c-web-hid` (or hand-roll a `.d.ts` ambient declaration file) — don't just cast to `any`, since Ledger transport correctness matters
- [ ] Generated hooks in `lib/api-client-react` mark `query.queryKey` as required in a way that fights the installed `@tanstack/react-query` version's `UseQueryOptions` type, causing `TS2741` in Dashboard.tsx, Blocks.tsx, Mempool.tsx, Network.tsx, WalletHome.tsx, WalletSend.tsx. This is type-only (the generated runtime code already falls back to a default `queryKey`) but still blocks `tsc --noEmit`. Fix by regenerating with an Orval version/template that matches the installed React Query major version, or by passing `queryKey` explicitly at each call site
- [ ] `wallet/crypto.ts` — separately from the runtime bug in item 1, `crypto.subtle.deriveKey`/`importKey` calls have a `Uint8Array<ArrayBufferLike>` vs `BufferSource` mismatch (line 136, 176) — likely a `@types/node` vs DOM lib version skew; confirm the fix doesn't paper over an actual buffer-detachment issue

### 4. `equilibrium/target/` is committed to git
3,376 files, ~850MB of Rust build artifacts (`.rlib`, `.rmeta`, `.so`, `.o`, cargo fingerprints) tracked in git — this is effectively the entire weight of the repo.

- [ ] Add `/target` (or `equilibrium/target/`) to `.gitignore`
- [ ] `git rm -r --cached equilibrium/target`
- [ ] Consider `git filter-repo` or BFG to strip it from history too, since it's already bloating every clone — coordinate timing with any open PRs/forks first

### 5. No automated tests anywhere
Neither `#[test]`/`#[cfg(test)]` in the Rust crate nor `.test.ts`/`.spec.ts` in the TS packages.

- [ ] Rust: unit tests for `stationary_solver.rs` (residual computation, gradient steps), `consensus.rs` (block validation), `wallet.rs` (keypair/address determinism)
- [ ] TS: unit tests for `chain/state.ts` (block application, reward math), `chain/utxo.ts` (coin selection, double-spend rejection), `wallet/crypto.ts` (mnemonic → address determinism, keystore round-trip)
- [ ] At minimum, a smoke test that boots `api-server` and hits every route once — would have caught bug #2 immediately
- [ ] Wire `pnpm run typecheck` (and, once tests exist, `pnpm test` / `cargo test`) into CI so this class of regression can't merge again

---

## P1 — Architecture decisions

- [ ] **Rust core vs. TS server.** Right now they're fully independent implementations of the same protocol with no bridge. Pick one:
  - (a) Bridge them — compile the Rust core to WASM and call it from `api-server`, or expose it via a local gRPC/IPC socket, so there's one source of truth for consensus math, or
  - (b) Formally designate the TS server as the reference implementation for testnet, and the Rust crate as the forward-looking mobile/native engine that will replace it later — document this explicitly so nobody assumes they're already in sync
- [ ] Decide what "done" means for the ZK proof — is `chain/zkproof.ts`'s hash-based simulation acceptable for public testnet (clearly labeled), or does it need real arkworks/circom wiring before any external testers see it?
- [ ] Reconcile the Rust `Cargo.lock` (v4 format, needs cargo ~1.78+) with whatever toolchain your CI/deploy environment actually has — this repo currently can't be `cargo check`ed on an older toolchain without regenerating the lockfile, which then pulls crates requiring even newer Rust (`edition2024`). Pin a minimum supported Rust version (MSRV) in `Cargo.toml` and document it in the README.

---

## P2 — Protocol / consensus completion

- [ ] Wire real Groth16 circuit (arkworks or circom) to the stationarity proof — replace `chain/zkproof.ts`'s simulated BN254 points with actual pairing-based proof generation/verification
- [ ] Full UTXO model hardening — `chain/utxo.ts` exists and is routed, but needs the same scrutiny as everything else given bug #2 was found in its route layer; audit coin selection, double-spend handling, and reorg behavior
- [ ] Floating-point determinism in `StationarySolver` — `f64` residuals/gradients can diverge by ~1e-8 across ARM (mobile) vs. x86 (cloud nodes), which is a consensus-fork risk. Evaluate fixed-point arithmetic for the consensus-critical path
- [ ] P2P catch-up sync robustness — mobile nodes will drop offline frequently; the current headers-first sync (`/api/sync/headers`) needs a resilience story for intermittent connectivity, not just bulk catch-up
- [ ] WASM contract execution (`chain/wasm.ts`) — currently uses Node's built-in `WebAssembly`; needs gas-metering review and a real contract deployment example beyond `contracts/examples`

---

## P3 — Infrastructure

- [ ] Wire the existing Drizzle/Postgres schema (`lib/db/`) into `api-server`, replacing (or backing) the in-memory `ChainState` — needed for restart persistence and multi-instance deployments
- [ ] WebSocket subscriptions for new blocks / mempool changes — explorer currently polls every 10s via React Query
- [ ] `@equilibrium/sdk` npm package — typed wrapper around the REST API for external integrators
- [ ] Multi-region testnet deployment (see below) — provision real, geographically distributed seed nodes instead of one box
- [ ] CI pipeline: typecheck + (once they exist) tests, on every PR, for both the Rust crate and the TS workspaces

---

## P4 — Mobile

- [ ] Android: turn `MiningService.kt` / `MiningWorker.kt` into an actual Gradle project (currently loose source files, no `build.gradle`, no `AndroidManifest.xml`); wire JNI bridge to the Rust FFI (`ffi.rs`); foreground service with `setRequiresCharging(true)` / `setRequiredNetworkType(NetworkType.UNMETERED)` (per earlier review notes — confirm these constraints are actually implemented, not just described)
- [ ] iOS: turn `MiningService.swift` / `EquilibriumBridge.h` into an actual Xcode project; `cargo-swift` bridge to the Rust core; BackgroundTasks API integration
- [ ] Stratum-style mining pool protocol for phones that can't run a full node continuously

---

## Infrastructure Provisioning (Hetzner)

Concrete setup tasks once you're ready to move off local/Replit and onto real infrastructure. Pricing context: Hetzner has repriced cloud servers four times in 2026 (most recently a large increase on CPX/CCX June 15), so confirm current prices at [hetzner.com/cloud](https://www.hetzner.com/cloud) before ordering — see the README's Deployment section for the current sizing rationale.

- [ ] Provision one **CX23** (2 vCPU/4GB) for a combined testnet box: Docker + `docker-compose` running `api-server` + `explorer` behind a reverse proxy (Caddy/nginx for TLS)
- [ ] Point the repo's existing `Dockerfile` at it; confirm the single-image build still works post-bugfixes
- [ ] Once traffic/usage justifies it, split into:
  - [ ] API node on its own **CX33** or **CAX21**
  - [ ] Postgres on a **CX33/CX43** or a small **AX dedicated root server** (price this against CCX before deciding — AX is likely cheaper post-June-2026 for a stable, always-on DB)
  - [ ] Explorer as a static build served from the API box or a CDN
- [ ] Stand up 3–5 **CX23** seed/validator nodes across at least two Hetzner regions (e.g., Falkenstein + Helsinki + Ashburn) running the Rust `testnet-node` binary, for genuine libp2p peer diversity instead of a single-box "network"
- [ ] Set up an hourly-billed on-demand box (CPX/CCX, sized up) for CI Rust builds (`libp2p` with `features = ["full"]` pulls 470+ crates — cold builds are slow); delete after each run rather than keeping it running
- [ ] Firewall rules: restrict Postgres and internal RPC ports to the private network between your own boxes (Hetzner Cloud Networks / private VLAN); only expose the API, explorer, and P2P ports publicly
- [ ] Set up basic monitoring: point Prometheus/Grafana (or VictoriaMetrics) at the existing `/metrics` endpoint — this is already implemented and just needs a scrape target
- [ ] Document DNS + TLS setup (Caddy auto-TLS is the simplest path) once you have a domain pointed at the testnet box
- [ ] Revisit sizing after the first few weeks of real usage — right-size before committing to anything beyond CX/CAX, since those are the tiers least affected by further 2026 price volatility

---

## Documentation

- [ ] Keep `README.md`'s "Future Work" checklist honest going forward — this update exists because the previous version listed BIP-39, HD derivation, hardware wallet support, multisig, and encrypted keystores as not-yet-done when they were already merged. Check off items in the same PR that implements them.
- [ ] Add a `CONTRIBUTING.md` if this is going to take outside contributors — at minimum, the Rust MSRV, the "always run codegen after editing the OpenAPI spec" rule, and the `pnpm --filter` (never bare `pnpm dev`) rule from `replit.md` should live somewhere more discoverable
- [ ] Add a short SECURITY.md given the recent Copilot Autofix commits (hardcoded crypto value, code sanitization, string escaping) — define how future scan alerts get triaged rather than auto-merged
