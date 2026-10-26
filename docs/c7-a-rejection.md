# C7-A Pass B — rejection ledger

Checkpoint of the relation: `3f3a600506c02da9591e8ec60248c99a4f128388`

Executable pins: `site/src/protocol/c7a-rejection.run.ts`, added after the mutation ledger.

`applySuccessor` clones the predecessor, mutates the clone, and on refusal returns `{ ok: false, error }`. The clone is not returned. These pins do not read it. They also do not change the transition.

A refusal before line 1104 happens before the clone exists. A refusal after that line can follow writes to the clone. The caller drops the clone. The predecessor is not written. The pins check that with a full field snapshot, not only `omegaDigest`, because that digest omits `tipHash`.

## What an error string can prove

Two cases are different.

- The error is produced by a later item, and the loop returns on the first refusal. Reaching that error means the earlier item returned success. For delegate, withdrawal open, and propose, success is after the writes in that operation. R-10a, R-10e, and R-10f are in this case. R-07 is in it as well: the second challenge returns `model is not bound` only when the row is already `slashed`, which the first challenge writes.
- The error string is shared, or it sits after a write inside one operation. A second run that changes only the overflowing field, and succeeds, isolates which line failed. It still does not display the discarded values. R-02, R-03, R-04, R-05, R-06, R-08, and R-09 are in this case.

R-01 reaches `coupling is not a coupling` only after `debit` returns. On a predecessor that already passed `monetaryError`, that debit cannot fail: `safeSub` of two safe integers is safe, and `debit` does not compare the balance with the amount. A negative result is left on the clone and abandoned with the coupling error. It is not repaired inside the operation.

The string in the working trace for a bad withdrawal signature was `withdrawal authority refused`. The source returns `withdraw authority refused`.

## Pins

| Id | Refusal | What the two runs separate |
| --- | --- | --- |
| R-01 | `coupling is not a coupling` | The same invalid coupling is refused after `debit` returns. A proposal with no coupling key is accepted. `debit` does not refuse an insufficient balance, so a zero proposer balance is not a separate error |
| R-02 | `withdrawal funds refused` | The same signed open is accepted when escrow is empty and refused when escrow is `MAX_SAFE_INTEGER` |
| R-02b | `balance refused` | An open signed by an account that is absent is not refused by `debit`. The final `monetaryError` refuses the candidate |
| R-03 | `amount refused` | The same signed transfer is accepted against the genesis miner balance and refused when that balance is `MAX_SAFE_INTEGER` |
| R-04 | `amount refused` | The same shape is accepted when the recipient is absent and refused when the recipient balance is `MAX_SAFE_INTEGER` |
| R-05 | `unbond payout refused` | The first matured row alone is accepted. Adding a second row whose delegator sits at the ceiling is refused |
| R-06 | `withdrawal refund refused` | One expired refund is accepted. A second expired refund to a ceiling balance is refused. Escrow holds both amounts, so the second debit is not the failing line |
| R-07 | `model is not bound` | A bound model is challenged, then challenged again. The second refusal is the slashed status written by the first |
| R-08 | `reward refused` | At predecessor height `-1` the continuity term floors the reward to 0, so this pin uses height 0. The clean step distributes a positive staked remainder. The same step is refused when a later validator, one that also receives a nonzero share, has `accumulatedRewards` at the ceiling. The product `staked * bondedStake` is a safe integer, so the failure is the reward increment |
| R-09 | `balance refused` | The predecessor nonce is `MAX_SAFE_INTEGER`, which passes `monetaryError`. The signed transaction uses that nonce. The refusal is the final `monetaryError`, after ordinary `nonce + 1` |
| R-10a | `delegate refused` | A signed delegate to the miner is followed by a signed delegate to an unknown validator |
| R-10d | `foreign observation is not in Ω` | A lock against a seeded BTC observation is followed by a lock against a hash that is not in Ω |
| R-10e | `withdraw authority refused` | A valid open is followed by an open whose signature is 64 zero bytes |
| R-10f | `btc header is not 80 bytes` | A valid delegate is followed by a BTC header that is not 80 bytes. Stake is applied before BTC |

R-10b and R-10c are not pinned. A second header that passes proof of work, and a signed Ethereum committee header, are not in the checked-in vectors. Building either inside the test would be a new cryptographic witness, not a use of the existing constructors. R-10f is the cross-category order pin that does not need that witness.

## Not claimed

These runs do not show the intermediate balances on the discarded clone. They do not make local `composeBlock` and `absorb` one relation. They do not close C7-A or C-007.

Pass C is still the WASM path split: `absorb` calls `successor`, and `composeBlock` and `commit` call `applySuccessor` without a `DerivedWasm`.
