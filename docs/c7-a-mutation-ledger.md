# C7-A Pass A — Ω mutation ledger

Checkpoint: `3f3a600506c02da9591e8ec60248c99a4f128388`

Source: `site/src/protocol/constitution.ts`, `dex.ts`, `authority.ts`, `chain.ts`, `wasm-host.ts`, `coinomics.ts`, `site/src/lib/chain-api.ts`

This is a source map of the production transition. It is not a normative freeze, not a circuit, and not a change to `applySuccessor`. C7-A stays open. C-007 stays open.

A field is accounted for only when its readers, writers, order, and commitment coverage are named. Finding the principal writer is not enough.

## What this pass corrects

Two claims in the working trace do not match this checkpoint.

- `monetaryError` checks both balance and nonce (`constitution.ts` lines 248–249). An unsafe nonce is refused. The sender increment is still ordinary `sender.nonce + 1`, not `safeAdd`.
- `OrganismNode.slash` has no caller in this repository. The public `stakeAction` route names `"slash"` and then `gateStakeAction` rejects it. There is no `node.slash` dispatch.

## 1. Inventory

`Omega` has these 22 fields (`constitution.ts` lines 63–89). `applySuccessor` clones the predecessor before any mutation (line 1104). A refusal returns the error and drops the clone. It does not write the predecessor.

| Field | Writers on the transition path | In `stateRootOf` | In `omegaDigest` |
| --- | --- | --- | --- |
| chainId | none | no | yes |
| height | set after the state root (line 1161) | no | yes |
| tipHash | not written here; sealing installs it on the carried state | no | no |
| tipTimestamp | set after the state root (line 1162) | no | yes |
| difficulty | set after the state root (line 1165) | no | yes |
| couplings | `openOmega`, before evidence | no | yes |
| ledger | `credit`, `debit`, `applyEffects`, stake, settlement, withdrawal, unbonding, refund | yes, sorted by address | yes, sorted by address |
| pools | `applySwap` only, from `applyEffects` | yes, sorted by id; `tokenA`/`tokenB` omitted | same omission |
| btc | append in evidence order; drop the oldest past 2016 | tip only (`height:hash`) | full records, array order |
| ethPubkey | `installCommittee` | no | yes, with the committee |
| ethCommittee | `installCommittee` | no | yes |
| eth | append in evidence order; no retention cap | tip only (`slot:hash`) | full records, array order |
| wasm | replaced from `DerivedWasm` when `evidence.wasm` is nonempty | yes, keys sorted | same |
| validators | stake, `blocksProposed`, `distribute` | no | yes, sorted by address |
| delegations | delegate append; unbond rebuilds the array | no | yes, array order |
| unbonding | unbond append; matured rows removed | no | only when nonempty |
| withdrawals | open appends; settle and refund change status | no | only when nonempty |
| ethExecution | `admitExecution` appends; drop the oldest past 256 | no | only when nonempty |
| proposals | `unshift` on propose; votes mutate tallies; `openOmega` marks passed rows executed | no | yes, array order |
| models | `unshift` on bind; challenge sets `slashed` | yes, array order | yes |
| settlements | lock appends; release sets `settled` | yes, array order | yes |
| finalizedHeight | advanced after the state root when the quorum holds | no | yes |

`tipHash` is the predecessor identity the next header binds as `prev`. Two states that differ only in `tipHash` have the same `omegaDigest`. That digest is not the predecessor identity.

## 2. Order inside `applySuccessor`

This order is the relation. Reordering it is a different transition.

1. Refuse an unknown chain, a nonce outside `u64`, a monetary or identity error, a difficulty that is not the predecessor's, a pressure outside `[0,1]`, or a timestamp that is not a safe integer and not monotonic.
2. Refuse any transaction whose signature does not verify. Refuse a list longer than `maxTxPerBlock`.
3. `selectSuccessorTxs` reads the predecessor ledger, not the candidate. The comparison against that selection is repeated after effects, because a fee credited inside the block is not a balance the selector saw.
4. Clone. `openOmega` executes proposals already `passed`. Their coupling change is visible to this block's residual. A proposal that passes during this block is not executed until the next `openOmega`.
5. The producer must be a live validator on that opened clone, before evidence. A slash later in this block does not unmake that check.
6. `applyMaterial`, in this order: one authority snapshot, then `stake`, then `btc`, then `eth`, then `settle`, then `withdraw`. The snapshot is not rebuilt.
7. If `evidence.wasm` is nonempty, the third argument must be a `DerivedWasm`. `inputs.wasmAfter` is not read. The map replaces `next.wasm`.
8. Residual and reward use the opened couplings, the predecessor `tipHash`, and the post-evidence state. `issuanceSplit` then reads the producer again. If that record is now jailed or slashed, the whole reward is liquid.
9. `applyEffects` in transaction-array order, then the liquid credit.
10. `admitModels`, `settleMaturedUnbondings`, `refundMaturedWithdrawals`.
11. `stateRootOf(next)` at this snapshot.
12. Cognition `bind` items must name that residual and that state root.
13. Increment `blocksProposed`. `distribute` adds floored shares to `accumulatedRewards`. Unassigned remainder is not credited.
14. `monetaryError` and `identityError` again.
15. Set height, timestamp, difficulty, and maybe `finalizedHeight`.
16. Return `next` and `omegaDigest(next)`. That digest sees the reward distribution. The state root does not.

`successor` is the only constructor of `DerivedWasm`. It runs `executeWasm` on a copy of `omega.wasm`, in evidence order, and passes `Math.max(0, omega.height)` as the block number. The host narrows that number with `>>> 0` (`wasm-host.ts` line 52). A call whose code is not `1` refuses the transition. The sorted copy returned by the host is not what gets installed; the mutated map is.

## 3. A1 — ledger

`credit` (`constitution.ts` lines 274–286) and `debit` (lines 288–297):

- A negative, fractional, or unsafe amount is refused.
- `credit(addr, 0)` inserts `{ balance: 0, nonce: 0 }` when the account is absent, and does not change an account that exists.
- `debit(addr, 0)` returns success and does not insert.
- A positive credit or debit preserves the nonce. Overflow is refused.

`applyEffects` does not use `debit` for the sender. It checks the nonce, subtracts `amount + fee` with `safeSub`, and writes `sender.nonce + 1`. The miner fee is credited before the recipient. Transactions run in array order, so transaction N is visible to N+1.

A pool destination calls `applySwap(pool, pool.tokenA, amount)`. It always sells `tokenA` for `tokenB`. It does not inspect a token field on the transaction. If the quote is 0, the pool is unchanged and the amount is not credited anywhere. The sender has already paid `amount + fee`, and the miner has the fee.

`stateRootOf` and `omegaDigest` both sort the ledger by address. Map insertion order is kept on the clone and discarded by both commitments. Membership, balance, and nonce are in both. Neither commitment proves the writes were the ones the relation required.

## 4. A2 — pools

`applySwap` in `dex.ts` is the only pool writer on this path. `quoteSwap` uses `amountIn * (1 - fee)` and `Math.floor`. The full input, not the fee-adjusted input, is added to the input reserve. `txCount` increments by ordinary addition.

`identityError` refuses a pool whose `id` is not `${tokenA}-${tokenB}`, or whose `address` is not `poolAddress(id)`. Every state that survives `applySuccessor` has token identities determined by `id`. The commitments still omit `tokenA` and `tokenB`. A digest comparison that does not run `identityError` will not see a broken pair.

`mine` previews swaps with `applySwap` on a copy while selecting transactions (`chain.ts` lines 632–653). That copy is not Ω. The transition runs `applySwap` again inside `applyEffects`.

## 5. A3 — foreign evidence, settlement, withdrawal

Inside one `withdraw` array, `exec` appends an execution header and a later `settleEth` can use it. An earlier `settleEth` cannot use a header admitted further down the array. `settleEth` proves a receipt and a transaction against that header. It does not verify Ethereum consensus.

`eth` consensus headers are appended with no length cap. `btc` keeps 2016. `ethExecution` keeps 256. A settlement lock requires the foreign reference to still be in the corresponding array, so a header that has fallen out of the window can no longer release.

BTC settlement of a withdrawal debits `WITHDRAWAL_ESCROW` and does not credit an EQU recipient. The same is true of `settleEth`. Refund of an expired lock debits escrow and credits the sender stored on the row. Open debits the sender and credits escrow. The amount on a refund is the stored amount, not an input.

## 6. A4 — two execution paths

`DerivedWasm` is a class in `constitution.ts`. A `Map` is not an instance of it.

| Path | Call | Nonempty `evidence.wasm` |
| --- | --- | --- |
| Received block, `absorb` | `successor` (chain.ts line 2140) | Executes the module, then `applySuccessor` with `DerivedWasm` |
| Local `composeBlock` | `applySuccessor` (line 542) | Third argument is omitted, so the call returns `wasm is executed by the successor`. Pending evidence is cleared and the block is retried with blank evidence |
| Local `commit` | `applySuccessor` (line 695) | Same refusal. `wasmAfter` on the input object is not consulted |

Local construction therefore does not execute nonempty WASM evidence. It drops that evidence and seals a different input. Received validation executes it. Those are not the same relation until the paths are reconciled. Pass C is that reconciliation. It is not done here.

## 7. A5 — authority

`applyMaterial` takes `authoritySnapshot(omega, params.finalityQuorum)` once, before the stake loop. Both networks set that ratio to `2/3` and the unbonding period to 10 (`networks.ts`).

| Op | Signature inside `applyStake` | What the public route does |
| --- | --- | --- |
| delegate | required, or `delegate authority refused` | `gateStakeAction`, then `node.delegate` with the signature |
| unbond | required | `gateStakeAction`, then `node.unbond` with the signature |
| claim | none | signature checked at the gate; queued evidence is `{ op: "claim", address }` |
| vote | none; voter must be in the snapshot | signature checked at the gate; queued evidence has no signature |
| propose | none; proposer must be in the snapshot; `unshift` | signature checked at the gate; queued evidence has no signature |
| slash | none | `gateStakeAction` returns `slash is not a public caller action` before any dispatch |

`claim`, `vote`, and `propose` are authenticated at `site/src/lib/chain-api.ts` and not in the evidence. `absorb`, `commit`, and `restoreDerived` replay `applySuccessor` or `successor`. They do not call `gateStakeAction`. A second body cannot see the HTTP signature.

`slash` reduces `bondedStake` by `floor(stake * 0.05)` or `floor(stake * 0.01)` (`coinomics.ts`). The burned amount is not credited. `double_sign` also sets `jailed`. The operation carries no issuer. `OrganismNode.slash` (`chain.ts` lines 1389–1398) would queue that evidence, and nothing in this repository calls it. A received block can still carry the operation. `ctp1.run.ts` already accepts an unsigned downtime slash and rejects an unsigned delegate. The transition relation is the authority law for slash today. No separate issuer has been found.

Voting uses the snapshot taken before the loop. Abstain counts toward quorum and not toward `yes > no`. A proposal that passes in this block does not change this block's couplings.

`matureAt` is `omega.height + unbondingPeriod` at the moment of the unbond, which is still the predecessor height. `settleMaturedUnbondings` pays when `matureAt <=` the successor height, in array order, and removes those rows.

## 8. Commitment boundary

`stateRootOf` (lines 317–334) is a merkle root of ledger, pools, the BTC tip, the ETH tip, wasm, models, and settlements. It is computed before `blocksProposed` and `distribute`.

`omegaDigest` (lines 354–415) is computed after those writes. It also covers chain, height, time, difficulty, finality, couplings, validators, delegations, and proposals. Unbonding, withdrawals, and execution headers are appended only when their encodings are nonempty. `tipHash`, `tokenA`, and `tokenB` are absent. `num` prints `-0` as `0`.

`transitionDigest` binds `omega.tipHash` and `omegaDigest(omega)` plus a canonical-evidence string. That string does not separate an absent optional list from an explicit empty list. `structuredInputId` does, and it is not a field of the version-1 statement.

Finality's stake totals at lines 1166–1169 use `Array.reduce` and `/`, not `safeAdd`. The authority snapshot uses `safeAdd`. Those are different arithmetic sites.

## 9. Not closed

| Pass | State |
| --- | --- |
| A1 ledger | Source-mapped. Nonce overflow is refused by `monetaryError`, not guarded at the increment |
| A2 pools | Source-mapped. Zero quote sinks the input. Commitments omit token names and rely on `identityError` |
| A3 foreign and escrow | Source-mapped. Not Ethereum consensus |
| A4 wasm | Source-mapped. Local construction and `absorb` are not the same relation |
| A5 authority | Source-mapped. Claim, vote, and propose signatures are not in the evidence. Slash has no issuer |
| B rejection ledger | Not started |
| C path reconciliation | Named by section 6. Not done |
| D commitment snapshots | Section 8 names the two roots. Nested field coverage is not a proof |
| C7-B encodings | Not accepted. FS1 is not what adoption consumes |
| C7-C circuit | Not authorized by this map |

The next pass is the rejection ledger: every refusal, the condition, and whether the clone had already been mutated. No circuit and no adoption change until Pass C has one relation for local construction and received blocks.
