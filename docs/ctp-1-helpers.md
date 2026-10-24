# CTP-1 Helpers

Bodies of the transition, as the interpreter computes them.

This file specifies four regions that [CTP-1 Relation](ctp-1-relation.md) previously only named: stake, transaction effects, the residual and the reward, and the wasm host. It does not specify bitcoin admission, ethereum admission, settlement, withdrawals, model admission, or transaction selection. Those remain open. C-007 remains open.

An integer in this file is an ECMA-262 safe integer unless a step names a bigint.

## 1. Ledger arithmetic

`safeAdd` and `safeSub` return null unless both arguments are safe integers and the result is a safe integer. `isSafeNonNegative` means a safe integer at least `0`. `isSafePositive` means a safe integer greater than `0`.

`credit(addr, amount)` refuses a negative or non-integer amount, and a predecessor balance that is not a safe non-negative integer. An amount of `0` succeeds. If the address is absent, that zero credit inserts `{ balance: 0, nonce: 0 }`. A positive credit writes `balance + amount` and keeps the nonce. It does not create the account when the addition overflows.

`debit(addr, amount)` uses the same refusal rule. An amount of `0` succeeds and does not insert an absent account. A positive debit writes `balance − amount` and keeps the nonce. It refuses when the subtraction is not a safe integer, including when the balance is smaller than the amount.

`monetaryError` walks ledger balances and nonces, validator bonded stake and accumulated rewards, delegation amounts, unbonding amounts and maturity, withdrawal amounts, nonces, heights, and status, and proposal deposit and tallies. It does not look at pool reserves. `identityError` requires each validator map key to be that validator's address with no duplicate, and each pool id to be `tokenA-tokenB` with a matching derived address and no hyphen inside a token symbol.

## 2. Authority snapshot

`authoritySnapshot` runs once, after the clone and before any stake operation. It walks the validator map in insertion order. A jailed, slashed, or non-positive validator contributes nothing. Overflow of the running total refuses the whole material step. The snapshot is `{ power, total, quorum }` where `quorum` is `finalityQuorum × total` in ECMA-262 multiplication.

Later stake operations in the same transition do not rebuild this snapshot. A delegation, a slash, or a jail in this block does not change who may vote or how much power that vote carries. A proposal that reaches quorum in this block is marked `passed` or `failed` here, and `openOmega` has already finished. The coupling write waits until a later transition.

## 3. applyStake

Stake operations run in the evidence array order. The first refusal stops the transition. An unknown op refuses.

### 3.1 Delegate

If the public key and the signature are both empty, refuse. Otherwise verify before any debit. Verification requires a 40-hex delegator, a 40-hex validator, a 64-hex public key, a 128-hex signature, and a positive safe integer amount. The signature is Ed25519 over the UTF-8 text

`eq-authority|v1|chainId|delegate|delegator|validator|amount|||||`

and the address derived from the public key must be the delegator. The address derivation is the first 40 hex characters of SHA-256 of the 32-byte key.

Then refuse if the validator is missing, jailed, or slashed, or if the amount is not a positive safe integer, or if the bonded stake cannot accept the addition. Debit the delegator. On success, add the amount to `bondedStake` and append one delegation row. The debit happens before the append. A failed debit leaves the stake unchanged.

### 3.2 Unbond

Verify before any release. The preimage is the same shape with `unbond` in the operation field. A delegate signature is not an unbond signature.

Refuse if the validator is missing, jailed, or slashed. Sum matching delegation rows in array order with `safeAdd`. Refuse if that sum is less than the amount or overflows. Refuse if bonded stake cannot subtract the amount, or if `height + unbondingPeriod` is not a safe integer. Height here is still the predecessor height.

Drain matching rows in array order. A row larger than the remainder is rewritten to the difference and the remainder becomes `0`. A row no larger than the remainder is omitted. Unrelated rows stay, in their original relative order. If the remainder is not `0` at the end, refuse. Otherwise write the reduced bonded stake and append `{ delegator, validator, amount, matureAt }`.

Slash does not rewrite delegation rows. An unbond after a slash in the same block still sees the old rows, and it still subtracts from the already reduced bonded stake.

### 3.3 Claim

No signature is checked in this function. Refuse if the validator is missing or its accumulated rewards are not a positive safe integer. Credit that entire balance to the validator address and set accumulated rewards to `0`.

### 3.4 Slash

No misconduct proof is checked in this function. Refuse if the validator is missing, already slashed, jailed, or has no positive bonded stake. The burned amount is `floor(bondedStake × 0.05)` for `double_sign` and `floor(bondedStake × 0.01)` for `downtime`. Refuse if that amount is not a safe non-negative integer or is greater than the bonded stake. Subtract it. The burned units are not credited. Set `slashed`. For `double_sign`, also set `jailed`.

### 3.5 Vote

No signature is checked in this function. The proposal must exist and be `open`. The voter's power is the snapshot value. Refuse if it is absent, or if that voter already has a ballot. Add the power to `yes`, `no`, or `abstain` with `safeAdd`, and append the ballot. If `yes + no + abstain` is a safe integer, the snapshot total is positive, and the tally is at least the snapshot quorum, set status to `passed` when `yes > no` and to `failed` otherwise. A tie fails. Abstain counts toward quorum and not toward the side.

### 3.6 Propose

No signature is checked in this function. The proposer must be in the snapshot. The deposit must be a safe non-negative integer, the id a non-negative safe integer, the title a string of at most 80 characters, and the id unused. Debit the deposit. A coupling, if either half is present, must be one of `hash`, `structural`, `continuity`, `mempool`, `fees`, and the value must be a finite number. Insert the proposal at the front of the array with status `open`, zero tallies, and empty ballots. Front insertion does not cause `openOmega` to execute it in this transition.

## 4. Transaction effects

After the reward has been computed, effects run in transaction array order. Then the liquid reward is credited. The returned swap list is not a field of `Ω`.

For each transaction, refuse unless the amount is a positive safe integer and the fee is a safe integer at least `0`, or unless their sum is a safe integer. The sender account, if absent, is balance `0` and nonce `0`. Refuse unless the sender nonce is a safe non-negative integer equal to the transaction nonce, and the balance is a safe non-negative integer at least the sum. Write the sender as `balance − amount − fee` and `nonce + 1`. Credit the fee to the miner. A fee of `0` still follows the zero-credit rule.

The recipient is a pool when some pool's `address`, or `poolAddress(id)` when the address is empty, equals `tx.to`. `poolAddress` is the first 40 hex characters of SHA-256 of `eq-pool:` plus the pool id.

A pool recipient calls `applySwap(pool, pool.tokenA, amount)`. The quote is `0` unless the amount is finite and positive, the input token is `tokenA` or `tokenB`, and both reserves are positive. The input with fee removed is `amount × (1 − pool.fee)` in ECMA-262 arithmetic. If that is not positive, the quote is `0`. Otherwise the quote is

\[
\left\lfloor \frac{dx \times \mathrm{reserveOut}}{\mathrm{reserveIn} + dx} \right\rfloor
\]

`applySwap` returns `0` without writing the pool when the quote is not positive. When the quote is positive it adds the gross amount to the input reserve, subtracts the output from the output reserve, and adds `1` to `txCount`. Those three writes are not safe-integer checked. `monetaryError` does not read the reserves.

The call from effects always passes `tokenA` as the input token. A pool spend does not credit `tx.to`. If the output is positive, a swap event is inserted at the front of the event list. The event carries the transaction timestamp. If the output is `0`, there is no event, the pool is unchanged, the sender has already paid amount and fee, and the amount is not credited to any account.

A non-pool recipient is credited the amount. Failure refuses.

After the list, refuse if the liquid reward is not a safe non-negative integer or if crediting it to the miner fails.

The liquid part was fixed before effects. If the miner is missing, jailed, or slashed at that earlier moment, the liquid part is the whole reward and the staked part is `0`. Otherwise the liquid part is `floor(reward × commission)` and the staked part is the difference. The reward itself is `max(0, floor(blockReward × quality))` of the canonical residual, using the parameter base and halving interval. `blockReward` is `0` when the height is not a finite non-negative number, and the base reward when the halving interval is not positive. Otherwise it is

\[
\mathrm{base} \times \left(\tfrac{1}{2}\right)^{\mathrm{height} / \mathrm{interval}}
\]

in ECMA-262 `Math.pow`. Quality is `0` when either argument is non-finite or negative. Otherwise it is

\[
\min\left(1,\ \frac{\mathrm{target}}{R + 10^{-9}}\right)
\]

`R` is `breakdown.canonical`, not the fixed-point residual and not the territory residual.

## 5. Residual

The residual `applySuccessor` uses is `evaluateResidual` of the parent hash, the transaction Merkle root, the timestamp, the nonce, the difficulty, one `{ hash, fee }` per transaction in order, cumulative work `max(0, nextHeight)`, the committed pressure, and the opened couplings.

The digest is a single SHA-256 of the concatenation of: the parent hash as 32 bytes, the Merkle root as 32 bytes, the timestamp as an unsigned 64-bit little-endian integer, the nonce as an unsigned 64-bit little-endian integer, and each transaction hash as 32 bytes. A hex field shorter than 32 bytes is padded with zeros on the right. A longer one is truncated. This digest is not the header hash.

`h` is the first 8 bytes of that digest, read as an unsigned little-endian integer, divided by `2^64` through `Number`. Integers above `2^53` are not exact in that conversion. That inexactness is part of the relation.

\[
\tau = \min\left(0.95,\ \max\left(0.05,\ \frac{10^{6}}{\mathrm{difficulty}+10^{6}} + 0.35\right)\right)
\]

The five violations are `max(h − τ, 0)`, the absolute value of `h − 1/φ`, `0` when cumulative work is positive and `1` otherwise, the committed pressure after `canonicalPressure` and then clamped to `[0, 1]`, and `max(0, pressureTerm − min(1, totalFees / 10^6))`. `φ` is `(1 + sqrt(5)) / 2` as computed by ECMA-262. The fee total is ordinary addition of the fee numbers, not `safeAdd`.

The canonical residual is the sum of `λ · v²` for those five pairs, using the opened couplings. The fixed point stored in the header is `floor(canonical × 10^18)`, or `-1` when the canonical residual is not a finite non-negative number.

The territory residual is also computed, from a different formula on the same digest, and it is not the reward input and not the header field.

The nonce search is not this function. `applySuccessor` evaluates the residual of the nonce it was given. It does not search.

## 6. Wasm host

`successor` is the only constructor of derived storage. The block number it passes is `max(0, predecessor height)`. Calls run in evidence order against one map, copied from the predecessor wasm map before the first call.

Method `init` is id `0` and its argument is the UTF-8 bytes of `caller`. Method `pause` is id `2` and `unpause` is id `3`. Both pass an empty argument.

`callArbitrage` instantiates `ARBITRAGE_WASM` and calls its exported `call`. The host imports are:

| Import | Effect |
| --- | --- |
| `storage_get` | Return `0` when the key is absent. Otherwise write the value into wasm memory and return its byte length |
| `storage_set` | Set the key in the host map. A repeated key keeps the map's original insertion position and replaces the value |
| `log` | Append a host log. The log is not part of `Ω` |
| `block_number` | The passed block number, forced through an unsigned 32-bit conversion |
| `caller_address` | Write the first 40 characters of the caller |
| `gov_param` | Return `0` |
| `dex_multi_swap` | Return `-1`. It does not move a pool |
| `call_contract` | Return `-1` |

A call whose returned code is not `1` refuses. The map carried forward is the host map after the calls, in insertion order. `callArbitrage` also returns a sorted copy of the entries. That copy is not the map `executeWasm` returns, and it is not the map written into `Ω`.

The signature checked by `gateWasmCaller` is not checked here. The evidence carries the method and the caller string. A proof of this host relation does not become a proof of that gate, and the gate is not part of `Reference`.

## 7. Still unnamed as bodies

Bitcoin header admission, ethereum committee and header admission, settlement, withdrawal application, model and binding admission, `selectSuccessorTxs`, and the contract instructions inside `ARBITRAGE_WASM` are not specified above. The host boundary is specified. The bytecode is identified by `ARBITRAGE_CODE` and is not transcribed here.

A circuit that implements sections 3 through 6 and treats the rest as names has not implemented `Reference`.
