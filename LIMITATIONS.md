# Limitations

Honest notes on gaps between the design brief, the documentation, and what is
actually implemented. These are not bugs to fix immediately — they are
deliberate trade-offs or features deferred until they are needed in anger.

---

## 1. `execute_arbitrage` does not roll back on profit undershoot

The `minProfit` parameter passed to `POST /api/arbitrage/execute` (and the
`minProfitFp` word in the on-chain call ABI) is **advisory only**. It is logged
as `ArbitrageUnderTarget` when the trade clears below the target, but the swap
is **not rolled back**. The token amounts are already settled in the DEX pools
by the time the profit check runs, and the current WASM host environment does
not support transactional rollback of multi-hop swaps.

**Practical impact:** A caller whose swap returns less than `minProfit` still
pays execution gas and still moves the pool price. They receive whatever profit
the trade produced — which may be zero or even negative in a fast-moving market.

**Workaround:** Use `GET /api/arbitrage/opportunities` immediately before
submitting an execute call and compare the quoted profit factor against your
`minProfit` threshold before committing. The circuit breaker (`MAX_EXECS_PER_WINDOW = 5`
executions per `arbitrage_window` blocks) limits exposure to a runaway bot in
the worst case.

**Reference:** `contracts/arbitrage/src/lib.rs` line 23, line 272;
`artifacts/api-server/src/chain/arbitrage.ts` line 146.

---

## 2. WASM host functions — what actually exists

The original design brief sketched several host functions that were never
implemented. The table below is the authoritative list of what `wasm.ts`
actually exports to the `env` import namespace.

### Implemented (16 host functions)

| Function | Signature | Purpose |
|---|---|---|
| `storage_get` | `(keyPtr, keyLen, resultPtr) → u32` | Read a storage key; returns value length (0 = missing) |
| `storage_set` | `(keyPtr, keyLen, valPtr, valLen)` | Write a storage key |
| `log` | `(msgPtr, msgLen)` | Append a message to the call's event log |
| `block_number` | `() → u32` | Current chain height |
| `abort` | `(msg, file, line, col) → never` | WASM panic hook |
| `verify_owner_sig` | `(msgPtr, msgLen, sigPtr, sigLen, pubkeyPtr, pubkeyLen, addrPtr, addrLen) → i32` | Ed25519 signature check bound to a derived address |
| `self_address` | `(outPtr) → u32` | Write this contract's own address into memory |
| `verify_residual` | `(reqPtr, reqLen) → i32` | Synchronous NTK residual check via CLI subprocess |
| `caller_address` | `(outPtr) → u32` | Write the invoking address into memory |
| `balance` | `(addrPtr, addrLen) → i64` | Ledger balance of any address |
| `gov_param` | `(namePtr, nameLen) → i64` | Read a governance-controlled chain parameter |
| `bond` | `(amount: i64) → i32` | Escrow funds from caller into this contract |
| `payout` | `(toPtr, toLen, amount: i64) → i32` | Pay out from this contract's escrow to an address |
| `dex_multi_swap` | `(poolIdsPtr, poolIdsLen, tokenInPtr, tokenInLen, amountIn: i64) → i64` | Execute a chain of AMM swaps |
| `model_predict` | `(reqPtr, reqLen, outPtr) → i32` | Sigmoid(dot(theta, x)) fixed-point inference |
| `call_contract` | `(addrPtr, addrLen, methodId, argsPtr, argWordCount) → i32` | Synchronous cross-contract call |

### Not implemented — design brief only

The following functions were mentioned in early design documents or status notes
but do **not** exist in the codebase:

| Function | Status | Notes |
|---|---|---|
| `slash_account` | ❌ Not implemented | Would penalise an on-chain address; validator slashing is handled off-chain by the admin key / multisig route instead |
| `transfer` | ❌ Not implemented | General-purpose token transfer; use `bond` / `payout` for contract-scoped escrow flows |

Adding either function would require extending `wasm.ts` and auditing all
contracts that could call it for reentrancy and balance-manipulation vectors.

---

## 3. ModelRegistry accuracy claims — synthetic data caveat

`variational-ai` computes residuals against whichever MNIST data is available
at runtime:

- **Real IDX files present** (`variational-ai/data/train-images-idx3-ubyte` etc.) — the solver trains on genuine MNIST; reported accuracy is real.
- **No IDX files** (the common case on Replit and in CI) — `load_synthetic_mnist()` generates Gaussian blobs. Residuals are small and the model "converges", but the task is trivial. Any accuracy figure reported in this mode is **not comparable to published MNIST benchmarks**.

The NTK kernel method (`NtkAction`) solves a kernel linear system `(K + λI)α = y`. The residual is the gradient norm of the dual objective — not classification accuracy. A near-zero residual proves stationarity of the solver, not that the model generalises. Verifying a model with residual = 0 on synthetic blobs tells you nothing about how it performs on real digit images.

**Reference:** `variational-ai/src/mnist.rs` (`load_synthetic_mnist`);
`variational-ai/src/ntk.rs` (`solve_ntk`).

---

## 4. Arbitrage — detection only, no autonomous execution safety rails

`GET /api/arbitrage/opportunities` and the Explorer's arbitrage panel are
read-only detectors. The on-chain `Arbitrage` contract exists and can execute
trades when called explicitly via `POST /api/arbitrage/execute`, but:

- **No automated trade submission** — the API server never calls execute autonomously.
- **No governance-controlled sizing limits** — `arbitrage_max_trade_amount` is a governance parameter, but there is no per-block rate limit at the API layer (only the on-chain circuit breaker).
- **No slippage protection enforced** — see limitation 1 (`minProfit` is advisory).

Moving to autonomous execution would require all three of the above plus a
formal security review of the `dex_multi_swap` host function's interaction with
pool reserves.

---

## 5. `call_contract` depth limit and gas semantics

The `call_contract` host function is capped at depth 8 (hardcoded in
`wasm.ts`). Gas for a nested call is deducted from the *parent's* remaining
budget — there is no separate gas stipend. A malicious contract can exhaust
the parent's gas with a deeply nested call chain. Treat `call_contract` as a
trusted-contract-only interface; do not expose it to untrusted bytecode
without imposing an explicit gas stipend at the call site.
