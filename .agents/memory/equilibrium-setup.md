---
name: Equilibrium setup
description: Run commands, ports, key architecture rules, and gotchas for the Equilibrium blockchain project
---

## TypeScript query hook pattern (TanStack Query v5 / Orval)
- Generated hooks (e.g. `useGetBlock`, `useGetTransaction`) require `queryKey` in the `query` options object
- Pattern: `{ query: { queryKey: getGetBlockQueryKey(param), retry: false, enabled: flag } }`
- The `getGet*QueryKey` helpers are exported from `@workspace/api-client-react`

## Chain persistence — cold boot and restart recovery
- `scripts/start-postgres.sh` now auto-runs `pnpm install --frozen-lockfile` if `node_modules` is missing before schema push (cold-boot safe)
- `loadBlocksFromDb()` truncates to the longest contiguous sequence from height 0 on gap/mismatch, then **prunes the bad suffix rows from the DB** so subsequent restarts don't re-hit truncation
- Only returns `null` (falls back to genesis) if the very first block isn't height 0 or the DB is empty
- `.replit` Project workflow is **sequential**: Postgres → API Server → Explorer (not parallel) to prevent startup race

## Search page
- Route: `/search/:query` — parallel block+tx lookup for 64-char hex hashes
- Auto-redirects if only one match; disambiguation UI if both; not-found/invalid-format states
- Layout.tsx handleSearch now routes 64-char hex to `/search/` (not `/tx/`)

## express-rate-limit
- Installed in `@workspace/api-server` — skip paths use `/api/tx/broadcast` (NOT `/api/tx/submit`)
- CORS: `ALLOWED_ORIGINS` env var (comma-separated); defaults to `*` dev / `false` prod (fail-closed)

## timeAgo / timestamp bug (fixed)
- Block timestamps are Unix **seconds**; `Date.now()` is ms — multiply block.timestamp × 1000
- Fixed in `artifacts/explorer/src/lib/format.ts`; also added `formatScientific` and `formatCompact` helpers

## Run commands & ports
- API server: `pnpm --filter @workspace/api-server run dev` → port 8080 (workflow: `API Server`)
- Explorer: `pnpm --filter @workspace/explorer run dev` → port 5000 (workflow: `Explorer`)
- Postgres: `bash scripts/start-postgres.sh` (workflow: `Postgres`)
- Codegen: `pnpm --filter @workspace/api-spec run codegen`
- Rust tests: `cd equilibrium && cargo test --lib` (27 tests: wallet + stationary_solver + consensus)
- TS tests: `pnpm --filter @workspace/api-server run test` (65 tests incl. governance sig coverage)
- Load test: `~/.local/bin/k6 run --vus 50 --duration 30s scripts/load-test.js -e BASE_URL=http://localhost:8080`
  - k6 binary must be re-downloaded each session: `curl -sSL https://github.com/grafana/k6/releases/download/v0.56.0/k6-v0.56.0-linux-amd64.tar.gz | tar -xz --strip-components=1 -C ~/.local/bin k6-v0.56.0-linux-amd64/k6`
  - k6 v0.56 does NOT support `TextEncoder` or Ed25519 — use `asciiToBytes()` helper and ECDSA P-256 for signing

## Workflow names (exact, for WorkflowsRestart)
- `API Server`, `Explorer`, `Postgres` — NOT "artifacts/api-server: API Server" etc.

## Postgres workflow port detection — FIXED
- Postgres was binding `127.0.0.1` so Replit's workflow runner couldn't detect port 5432 → `DIDNT_OPEN_A_PORT` timeout on every restart
- Fix: set `listen_addresses = '0.0.0.0'` in both `scripts/start-postgres.sh` (new-init path) AND `.pgdata/replit.conf` (existing data dir)
- After this change, `WorkflowsRestart("Postgres")` completes cleanly

## Postgres role/permission — ROOT CAUSE (fixed)
- Replit injects `PGDATABASE=heliumdb`, `PGHOST=helium`, `PGUSER=postgres` env vars for its managed DB integration
- Any `psql` call without explicit `-d` and `-h 127.0.0.1` silently connects to the wrong host/db (helium/heliumdb) → role creation and grants fail with `2>/dev/null` hiding the error
- **Fix applied** in `scripts/start-postgres.sh`: `unset PGHOST PGPASSWORD PGDATABASE` at top + force `PGUSER="$(whoami)"` + add `-d postgres` to all role-management psql calls
- After fix, Postgres log shows: "Role 'runner' ensured." → "Schema up to date." → "Granted table/sequence access to runner." with no manual steps needed
- Manual fallback (if script somehow still fails): run the three psql commands with explicit `-d postgres` and `-d equilibrium` flags, then restart API Server

## Address derivation — CRITICAL
- Rust: `SHA-256(pubkey.as_bytes())[..20]` as 40 hex chars (raw 32 bytes)
- TypeScript (fixed): same — hash raw bytes, not UTF-8 of hex string
- `deriveAddress` in `artifacts/explorer/src/wallet/crypto.ts` validates 64-char hex input
- Old (buggy) behaviour was `SHA-256(TextEncoder.encode(hexString))` → different address for same keypair

## ZK encoding — shared constant
- `fpEncode(x) = floor(x * 1_000_000_000) % FIELD_ORDER`
- Both `chain/zk-encoding.ts` and `zk_proof.rs` must use this exact formula
- Public inputs order: [residual_fp, block_hash_low, block_hash_high, threshold_fp]

## Mining loop pattern
- Auto-miner uses `miningGeneration` counter (not a boolean flag) to prevent double-schedule race on rapid stop→start

## Governance module
- `artifacts/api-server/src/chain/governance.ts` — `GovernanceModule` class
- Voting power anti-double-count rule: validators vote with SELF-BOND only (bondedStake − delegated total); delegators vote with their own delegation. Total = totalBondedStake, no overlap.
- Quorum: 33.4%, Pass: simple majority of cast votes
- Vote endpoint requires `publicKey` (exactly 64 hex chars) + `signature` (exactly 128 hex chars) + Ed25519 verification
- Routes at `/api/governance/proposals`, `/api/governance/proposals/:id`, `/api/governance/proposals/:id/vote`, `/api/governance/params`

## Fixed-point fork-choice
- `reorganize()` in `state.ts` uses `BigInt(Math.floor(r * 1e18))` — must be `Math.floor`, NOT `Math.round`, to match `fpEncode` in `zk-encoding.ts`

## OpenAPI / codegen gotcha
- Governance paths must go inside the `paths:` section (before `components:`), NOT appended to the file end
- After any openapi.yaml edit: `pnpm --filter @workspace/api-spec run codegen`

## Rust pub(crate) pattern
- `joint_residual_and_gradient` and `update_multipliers` in `stationary_solver.rs` are `pub(crate)` so tests can call them

## Load test baseline (local Replit container)
- 50 VUs, 30s, ECDSA P-256 signed transactions → **161 TPS sustained, 100% acceptance, p95 latency 3ms**
- Exceeds the 100 TPS mainnet target

## WAT contract authoring gotcha (cost me a full debug cycle)
- `(data (i32.const N) "some literal")` only occupies as many bytes as the actual string content — do NOT assume a round/padded length; count bytes exactly (e.g. with `printf '...' | wc -c`) before hardcoding a length constant used in `memory.copy`/offset math elsewhere in the module. An off-by-one here silently splices a stray `\0` into a downstream buffer (e.g. a signed message), and Ed25519 verification then fails with no other symptom — the bug looks like a signature/crypto bug, not a memory-layout bug.
- General debug approach that found it: capture raw bytes crossing a host-import boundary (hex-dump message/sig/pubkey exactly as read from WASM memory) and diff against the "expected" bytes computed independently in JS — text-only `console.log` comparisons can visually look identical while hiding a length/byte mismatch.

## WASM VM instantiation model
- `WasmVM.call()` in `chain/wasm.ts` instantiates a **fresh WebAssembly instance/memory on every call** — only `contract.storage` (plain JS object) persists across calls. Contracts must be written store-not-compute: any WAT function relying on WASM globals/memory persisting between calls will silently reset each call.
- Multisig-style contracts needing "this contract's own address" or other host-verified identity should get it via a host import (e.g. `self_address`) rather than trying to cache it in WASM memory/globals.

## Two parallel balance systems — fee/reward crediting
- Chain has both an account-model `Ledger` (used for account tx fees/rewards) and a `UTXOSet` (used for coinbase rewards + UTXO addresses) — any new fee/reward logic must be added to BOTH paths or it silently only works for one tx type.
- UTXO-model transactions settle instantly at submission time, outside block assembly — so anything that should happen "per block" (like fee crediting) must be accrued in a counter on submit and swept into a block on `addBlock()`, mirroring the existing coinbase-UTXO pattern. Don't assume all value-transfer logic funnels through block assembly just because the account model does.
- Per-block fee auditing (`GET /api/blocks/:hashOrHeight/fees`, Explorer's "Miner Fee Breakdown" panel on BlockDetail) reads account fees from `block.transactions` and the swept UTXO fee via the deterministic `hash256('utxo-fees-${height}-${hash}')` UTXO lookup — reuse that same derivation anywhere else you need to find a block's swept fee UTXO.

## Smart Contracts — UI (Contracts page)
- Route: `/contracts` (deploy + list tabs) and `/contracts/:address` (detail + call + storage)
- Files: `artifacts/explorer/src/pages/Contracts.tsx`, `artifacts/explorer/src/pages/ContractDetail.tsx`
- wabt uses `export =` (CJS) — dynamic import pattern: `const mod = await import("wabt") as any; const loader = mod.default ?? mod; wabtInstance = await loader();`
- wabt installed in `@workspace/explorer` — lazy-loaded on first compile click (avoids bundle bloat)
- Contracts nav link added to Layout.tsx; routes added to App.tsx
