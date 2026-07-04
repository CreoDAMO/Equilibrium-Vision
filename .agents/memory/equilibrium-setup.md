---
name: Equilibrium setup
description: Run commands, ports, key architecture rules, and gotchas for the Equilibrium blockchain project
---

## Run commands & ports
- API server: `pnpm --filter @workspace/api-server run dev` → port 8080 (workflow: `artifacts/api-server: API Server`)
- Explorer: `pnpm --filter @workspace/explorer run dev` → port 5000 (workflow: `artifacts/explorer: web`)
- Postgres: `bash scripts/start-postgres.sh` (workflow: `Postgres`)
- Codegen: `pnpm --filter @workspace/api-spec run codegen`
- Rust tests: `cd equilibrium && cargo test --lib` (15 tests: wallet + stationary_solver)
- Load test: `k6 run scripts/load-test.js -e BASE_URL=https://<repl>.replit.dev` (requires k6 ≥ 0.46)

## Address derivation — CRITICAL
- Rust: `SHA-256(pubkey.as_bytes())[..20]` as 40 hex chars (raw 32 bytes)
- TypeScript (fixed): same — hash raw bytes, not UTF-8 of hex string
- Old (buggy) behaviour was `SHA-256(TextEncoder.encode(hexString))` → different address for same keypair
- `deriveAddress` in `artifacts/explorer/src/wallet/crypto.ts` is now correct; validates 64-char hex input

## ZK encoding — shared constant
- `fpEncode(x) = floor(x * 1_000_000_000) % FIELD_ORDER`
- Both `chain/zk-encoding.ts` and `zk_proof.rs` must use this exact formula
- Public inputs order: [residual_fp, block_hash_low, block_hash_high, threshold_fp]

## Mining loop pattern
- Auto-miner in `artifacts/api-server/src/chain/index.ts` uses `miningGeneration` counter (not a boolean flag)
- `stopMining()` bumps generation → in-flight cycles check `generation === miningGeneration && miningEnabled`
- Prevents double-schedule race on rapid stop→start

## Governance module
- `artifacts/api-server/src/chain/governance.ts` — `GovernanceModule` class
- Voting power = bonded stake ONLY (validators + delegator stakes); ledger balance excluded — quorum denominator is `totalBondedStake`
- Quorum: 33.4%, Pass: simple majority of cast votes
- `processBlock(now, totalBondedStake)` called in `ChainState.addBlock()` after `distributeBlockReward`
- Routes at `/api/governance/proposals` (list/create), `/api/governance/proposals/:id` (detail), `/api/governance/proposals/:id/vote`, `/api/governance/params`
- **Known gap**: vote route trusts caller-provided `voter` string — needs signature verification before mainnet (Task #2)

## OpenAPI / codegen gotcha
- Governance paths must go inside the `paths:` section (before `components:`), NOT appended to the file end
- After any openapi.yaml edit: `pnpm --filter @workspace/api-spec run codegen`

## Postgres persistence
- Schema push: `DATABASE_URL=postgresql://runner@127.0.0.1:5432/equilibrium pnpm --filter @workspace/db run push`
- Role "runner" is created by `scripts/start-postgres.sh` — must run first
- API server degrades gracefully (in-memory only) when tables don't exist; logs WARN on each persist fail

## Rust pub(crate) pattern
- `joint_residual_and_gradient` and `update_multipliers` in `stationary_solver.rs` are `pub(crate)` so tests can call them
- Do not make them `pub` — they are internal to the consensus engine

## Fixed-point residual (pending — Task #3)
- f64 fork-choice comparisons can diverge across ARM vs x86
- Plan: add `residualFp: bigint = floor(residual * 1e9)` to `BlockRecord`, use it in `reorganize()` and `choose_fork`
