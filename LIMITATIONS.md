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

## 5. `verify_residual` runs in a Worker thread (non-blocking, with sync fallback)

**Affected code:**  
- `artifacts/api-server/src/chain/wasm.ts` — `verify_residual` host import

**Behaviour:**  
`verify_residual` is called from inside a WASM host import, which the WebAssembly runtime requires to be synchronous. The implementation uses a Node.js `Worker` thread (via `worker_threads`) to call the `variational-ai-cli` binary off the main thread, then uses `Atomics.wait` on a shared `SharedArrayBuffer` to block the calling thread until the worker completes — effectively making the synchronous WASM interface non-blocking from the event loop's perspective. The worker is spawned once per WASM VM instance and reused.

**Fallback:** When there is no `hostCtx` (e.g., in direct unit tests) or when called from a non-main thread, the implementation falls back to `execFileSync` (synchronous, blocking). This fallback path is only exercised in test environments.

**Remaining constraint:** The CLI binary is still capped at one invocation per contract call, and a SIGKILL timeout (10 seconds) applies to both paths. A hung CLI process will block the Worker thread for up to 10 seconds but will not block the main event loop.

---

## 6. `call_contract` cross-calls do not roll back on failure

**Affected code:**  
- `artifacts/api-server/src/chain/wasm.ts` — `call_contract` host import

**Behaviour:**  
If a parent contract calls `call_contract(childAddr, ...)` and the child call fails, the child's storage mutations may already have been partially applied to the in-memory contract storage before the failure was detected.  The parent receives `-1` as the return value, but no automatic rollback of the child's writes occurs.

**Workaround:**  
Contracts that require all-or-nothing child call semantics must implement their own undo logic (e.g., read-check before write, or two-phase commit via storage flags).

---

## 7. TS ZK proofs use a simulated (trapdoor) witness, not a real circuit witness

**Affected code:**  
- `artifacts/api-server/src/chain/zkproof.ts` — `generateZkProof`, `verifyZkProof`
- `artifacts/api-server/src/chain/wasm.ts` — `get_verifying_key`, `verify_groth16_proof` host imports

**Behaviour:**  
`generateZkProof` derives the proof points using the Groth16 trapdoor formula
`c = (a·b − α_s·β_s − vkX_s·γ_s) · δ_s⁻¹` so that the proof satisfies the
full BN254 pairing equation.  `verifyZkProof` performs the complete check:
- VK hash and circuit ID binding
- Public-input statement: `residualFp < thresholdFp`
- Curve membership: π_A ∈ G1, π_B ∈ G2, π_C ∈ G1
- Full Groth16 pairing: `e(−π_A, π_B) · e(α, β) · e(vk_x, γ) · e(π_C, δ) = 1_Fp12`

All 41 `chain.unit` tests pass including the end-to-end pairing round-trip.

**What this is NOT:** a proof generated from a real arithmetic circuit over the
solver's witness.  The trapdoor approach produces a mathematically valid proof
for any residual value that satisfies `residualFp < thresholdFp` — it does not
cryptographically bind the proof to a specific solver computation.  Real circuit
security (where only a genuine solver can produce a valid proof) requires a
per-problem witness generator and a compiled Groth16 circuit, which remains
future work (see §1b and LIMITATIONS note on zkML).

**ModelRegistry inference attestation** is an Ed25519 attribution receipt, not zkML.  ERC-7992 / DeepProve on-chain model-inference circuit verification is **future work** and is not present in this repository.

**Impact:**  
The `verify_groth16_proof` WASM host import runs the full TS pairing verifier.
Proofs generated by this node pass the complete pairing check.  Do not treat
this as equivalent to a circuit-constrained proof — the trapdoor means any
party who knows the VK toxic waste could forge a proof for any valid residual.

---

## 8. CrossChainRelay uses BLS aggregate signatures (not individual Ed25519 per relayer)

**Affected code:**
- `contracts/cross_chain_relay/src/lib.rs` — `method_submit_inbound`
- `artifacts/api-server/src/chain/crossChainRelay.ts` — `SubmitInboundParams`

**Behaviour:**
`POST /api/relay/attest/inbound` now requires a single BLS12-381 G2 aggregate signature (`aggSigHex`, 192 hex chars = 96 bytes) plus an array of `signers[]` (each with a G1 pubkey, 96 hex chars = 48 bytes, and address). The contract aggregates the pubkeys on-chain via the `bls_aggregate_pubkeys` host import and verifies the aggregate signature via `bls_verify`.

The signing flow for clients:
1. Hash the canonical message `attest:{chainId}:{seq}:{commitmentHex}` to a G2 point via `G2.hashToCurve()`
2. Each relayer signs the G2 point: `BLS.sign(msgPoint, privKey).toBytes(true)` — 96 bytes
3. Aggregate all signatures: `BLS.aggregateSignatures([sig1, sig2, ...]).toBytes(true)` — 96 bytes
4. Submit `aggSigHex` + `signers[]` to the API

**Why BLS over Ed25519:**
BLS aggregate signatures shrink per-relay calldata from 34 words/signer (64-byte sig + 32-byte key + 40-byte addr) to 22 words/signer + 24 words total for the aggregate sig. For n=5 relayers: 34×5=170 words (Ed25519) vs 22×5+24=134 words (BLS) — ~21% smaller, and the pairing-based security is stronger. The tradeoff is ~1 pairing check on the host side (15 000 gas units).

---

## 9. Mining requires `ALLOW_RANDOM_MINING=true` in non-production environments

**Affected code:**
- `artifacts/api-server/src/chain/mining-policy.ts` — `assertRandomMiningAllowed()`
- `artifacts/api-server/src/chain/state.ts` — `mineNextBlock()`

**Behaviour:**
`mineNextBlock()` calls `assertRandomMiningAllowed()` at entry. If `ALLOW_RANDOM_MINING` is not set to `"true"` **and** `NODE_ENV` is `"production"` **or** `REQUIRE_REAL_SOLVER` is `"true"`, the function throws `"REQUIRE_REAL_SOLVER: consensus-api solveBlock is unavailable"` and the auto-miner stops.

**Why:**
This is a deliberate fail-closed policy. In production, every solved block must come from the real Rust `consensus-api` binary (genuine Lagrangian optimization). Allowing RNG residuals in production would let any node fake proof-of-stationarity, undermining the consensus guarantee.

**For testnet / development:**
Set `ALLOW_RANDOM_MINING=true` as an environment variable (via the Replit secrets UI or your `.env` file). The Replit dev environment sets this automatically via the configured workflow environment.
