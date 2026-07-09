# Equilibrium — Known Limitations

This document records intentional design constraints and non-obvious runtime boundaries.  
It is referenced by inline comments in the Arbitrage contract source and TypeScript chain modules.

---

## 1. Arbitrage `minProfit` is advisory, not a revert guard

**Affected code:**  
- `contracts/arbitrage/src/lib.rs` — `execute_arbitrage()`  
- `artifacts/api-server/src/chain/arbitrage.ts` — `ExecuteArbitrageParams.minProfit`

**Behaviour:**  
When `POST /api/arbitrage/execute` is called with a `minProfit` value, the contract executes the swap chain and compares the realised profit against the target.  If profit falls short, the contract logs `ArbitrageUnderTarget` and **returns a success code** — it does **not** roll back the swaps that have already been applied.

**Why:**  
The WASM execution environment has no native transaction semantics.  An atomic "execute-or-revert" multi-hop swap would require pre-simulating every hop in read-only mode, comparing against `minProfit`, and only then executing — or maintaining a full undo log.  Neither pattern is implemented.  The advisory `minProfit` exists to let callers signal their intent and have it surfaced in contract logs; enforcement is the caller's responsibility (simulate off-chain via `GET /api/arbitrage/opportunities` before calling execute).

**Workaround:**  
Use the read-only Bellman-Ford scan (`GET /api/arbitrage/opportunities`) to estimate the expected profit before calling execute.  If the expected profit is below `minProfit`, do not call execute.

---

## 1b. Inference attestation is an Ed25519 receipt, not a zkML proof

**Affected code:**
- `contracts/model_registry/src/lib.rs` — `submit_inference_attestation()`, `get_inference_status()`, `get_capabilities()`
- `artifacts/api-server/src/chain/modelRegistry.ts` — `submitInferenceAttestation()`, `getInferenceStatus()`
- `artifacts/api-server/src/routes/models.ts` — `POST /api/models/:id/inference-proof`, `GET /api/models/:id/inference-status`

**Behaviour:**
`POST /api/models/:id/inference-proof` records that a named keyholder (`attestorAddress`) cryptographically signed a claim of the form "running model `id` on some input hashing to `inputHash` produced an output hashing to `outputHash`". The contract verifies the Ed25519 signature via the same `verify_owner_sig` host import the multisig contract uses, and stores the hashes + attestor address on-chain. `get_capabilities()` reports a bitmask (`1` = training oracle, `2` = inference attestation) so callers can introspect what a given ModelRegistry deployment supports, in the spirit of the draft's `supportsInterface` idea — but as a simple on-chain bitmask read, not an EIP-165-style Solidity interface check.

**What this is NOT:** a zero-knowledge proof that the model actually produced that output from that input. There is no witness generator, no arithmetic circuit over the model's weights, and no verifier that checks computational correctness — only that a specific keyholder attested to a specific (input, output) hash pair for a specific model.

**Why:** Real zkML (à la the draft's ERC-7992/DeepProve sketch) requires a per-model witness generator and a SNARK circuit describing the model's arithmetic — a substantial, model-architecture-specific undertaking, and a meaningfully different engineering investment than the rest of this codebase's optimistic-oracle pattern (propose/verify/challenge, already used for training claims). The attestation scheme reuses proven primitives (Ed25519 verification already live in the multisig contract) to get a genuinely useful "who claims this output for this input" record now, while being explicit that stronger correctness guarantees are future work requiring dedicated cryptographic engineering, not a quick add-on.

**Workaround:** For workloads that need actual correctness guarantees (not just attribution), pair this with an off-chain challenge process, similar to the existing training-claim `challengeModel` flow, or wait for a dedicated zkML circuit implementation.

---

## 2. DEX pool state is in-memory only (no Postgres persistence)

**Affected code:**  
- `artifacts/api-server/src/chain/state.ts` — `createPool()`  
- `artifacts/api-server/src/routes/dex.ts` — pool creation routes

**Behaviour:**  
Pools created after genesis (via the API or the arbitrage demo seed) live only in the in-memory `ChainState.dexPools` map.  A server restart rebuilds pools from `genesis.json`'s `dex_pools` array; any pool created at runtime is lost.

**Why:**  
Pool state was intentionally kept in-memory to keep the schema simple.  The genesis pools (EQU-WBTC, WBTC-USDC) are the canonical pool set; runtime-created pools are for development use only.

---

## 3. Arbitrage execution is owner-gated; detection is permissionless

**Affected code:**  
- `artifacts/api-server/src/routes/arbitrage.ts`

**Behaviour:**  
`GET /api/arbitrage/opportunities` is public and performs no on-chain state mutation.  
`POST /api/arbitrage/execute` is permissionless at the HTTP level (any caller may attempt it) but the contract enforces an `is_owner()` check internally for the `set_model` and `pause` / `unpause` actions; execution itself is restricted to the owner until governance widens the permission.

---

## 4. `slash_account` and `transfer` are not implemented host functions

**Affected code:**  
- `artifacts/api-server/src/chain/wasm.ts`

**Behaviour:**  
Earlier planning documents referred to `slash_account` and `transfer` as WASM host functions.  These **do not exist**.  The actual ledger-mutation host functions available to contracts are:

| Host function | Purpose |
|---|---|
| `bond(amount)` | Debit caller → credit this contract (stake escrow) |
| `payout(to, amount)` | Debit this contract → credit `to` (slash reward / refund) |
| `dex_multi_swap(poolIds, tokenIn, amountIn)` | Execute AMM hop chain from this contract's balance |

Direct arbitrary balance transfers between arbitrary addresses are not available to contracts by design — all fund movements go through the escrow (`bond` / `payout`) or DEX (`dex_multi_swap`) paths.

---

## 5. `verify_residual` blocks the Node.js event loop

**Affected code:**  
- `artifacts/api-server/src/chain/wasm.ts` — `verify_residual` host import

**Behaviour:**  
`verify_residual` calls the `variational-ai-cli` binary via `execFileSync`, which is synchronous and blocks the event loop for the duration of the CLI process (up to 10 seconds before SIGKILL).  It is capped at one invocation per contract call to bound the worst-case blocking time.

**Why:**  
WASM host imports must be synchronous (there is no Asyncify in the current build pipeline).  A persistent worker process (`long-running-worker` enhancement in TODO) would eliminate this limitation but is not yet implemented.

---

## 6. `call_contract` cross-calls do not roll back on failure

**Affected code:**  
- `artifacts/api-server/src/chain/wasm.ts` — `call_contract` host import

**Behaviour:**  
If a parent contract calls `call_contract(childAddr, ...)` and the child call fails, the child's storage mutations may already have been partially applied to the in-memory contract storage before the failure was detected.  The parent receives `-1` as the return value, but no automatic rollback of the child's writes occurs.

**Workaround:**  
Contracts that require all-or-nothing child call semantics must implement their own undo logic (e.g., read-check before write, or two-phase commit via storage flags).
