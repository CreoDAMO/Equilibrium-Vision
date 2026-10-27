# C-007 closure matrix

Anchor: `1ddb0fe68bbfd321feaaedf8e051d78e5fc902ec`

This is the join between the mutation ledger and the adoption paths. It is not a circuit, and it does not change `applySuccessor`. C-007 stays open. The executable half is `site/src/protocol/c7-closure.run.ts`.

The audit's claim that `contracts/arbitrage/src/lib.rs` is an empty directory is not what this repository tracks. The file is in git. A hash of the embedded module is not a proof that a fresh build matched it, and it is not the host ABI.

## The four states

One transition is four objects. A proof of one of them is not a proof of the others.

| Stage | Object | Identity that names it today | What that identity misses |
| --- | --- | --- | --- |
| Ωpre | Predecessor passed to `applySuccessor` | `statement.predecessor` = `fullStateId` | `omegaDigest` omits `tipHash` and can match a different FS1 |
| Ωroot | Clone at the `stateRootOf` call | `statement.stateRoot` only | No FS1 of this snapshot. The root omits validators, proposals, couplings, height, and the pool token names |
| Ωrel | `stepped.next`, before the new tip is written | `statement.successor` = `fullStateId(stepped.next)` | `omegaRoot` is a later projection of this same object, not a second state |
| Ωcarried | `stepped.next` with `tipHash` set to the sealed header | `statement.carried` | This is the predecessor of the next block. It is not Ωrel |

`transitionRoot` still hashes `omegaDigest` of Ωpre plus the canonical evidence string. The statement's predecessor field hashes FS1. Those two commitments are not the same fact. `encodeInputs` stores the canonical evidence string, which does not separate an absent list from an empty list. `structuredInputId` does, and it is not a field of `TransitionStatement`.

`verifyTransitionProof` returns `no complete transition proof is defined` for every call. `ADOPTION_REQUIRES_TRANSITION_PROOF` is false. `adoptionGate` then returns success with `enforced: false`. `verifyCtp1` re-executes `successor`. That is a conformance check.

## Where each write sits

Order is the relation. The stage column is the first object that contains the write.

| Write | Function | Stage | Caused by | Bound by a statement field? | Checked before adopt? |
| --- | --- | --- | --- | --- | --- |
| Passed proposals executed, couplings updated | `openOmega` | Ωrel, and the couplings are already visible to the residual that feeds Ωroot | Proposals that were `passed` on Ωpre | Only inside FS1 of Ωrel and Ωcarried | No |
| Stake, BTC, ETH, settlements, withdrawals | `applyMaterial`, in that category order | Ωrel, and the ledger and pool effects are inside Ωroot | Ordered evidence | FS1 of Ωrel. `inputId` does not distinguish absent from empty | No |
| `wasm` map replaced | `applySuccessor`, only from a `DerivedWasm` | Ωrel, inside Ωroot | `evidence.wasm`, executed by `successor` | `statement.wasm` is the program hash, not the storage map and not the host | No |
| Transaction debits, fees, swaps, liquid credit | `applyEffects` | Ωrel, inside Ωroot | Ordered transactions and `issuanceSplit` | Inside FS1 and the ledger leaves of `stateRoot` | Replay compares roots. No proof |
| Model status | `admitModels` | Ωrel, inside Ωroot | `evidence.cognition`, before the root | Inside both roots | No |
| Matured unbonding and expired refunds | `settleMaturedUnbondings`, `refundMaturedWithdrawals` | Ωrel, inside Ωroot | Height and the rows on Ωpre | Unbonding and withdrawals are in `omegaDigest` only when nonempty. They are not in `stateRoot` | No |
| `stateRoot` | `stateRootOf` | The Ωroot commitment | The clone at that line | `statement.stateRoot` | Replay, when the block carries it |
| Cognition bind | `admitBinding` | No Ω write. Refusal only | Must name this residual and this root | Not a state field | No |
| `blocksProposed`, `accumulatedRewards` | increment, then `distribute` | Ωrel, after Ωroot | Reward remainder and live stake | In `omegaRoot` and in FS1. Not in `stateRoot` | Omega root replay is optional |
| Height, timestamp, difficulty, finality | end of `applySuccessor` | Ωrel, after Ωroot | The header inputs and the live-stake ratio | In `omegaRoot` and in FS1. Not in `stateRoot` | No proof |
| `tipHash = H` | `sealFromSuccessor` | Ωcarried only | The sealed header | `statement.header` and `statement.carried` | The header is stored. The proof is not |

`debit` does not refuse an insufficient balance. A negative balance on the clone is refused only if execution reaches the final `monetaryError`. That refusal drops the clone. It is not a rollback inside the operation.

## Installation paths

None of these call `verifyTransitionProof`.

| Path | What it executes | What it installs | Gap |
| --- | --- | --- | --- |
| `composeBlock` | `executeTransition`, which is `runSuccessor` | The sealed block for that input. A refusal throws and leaves the staged evidence in place | The proof gate is still absent |
| `commit` | `executeTransition` again, against the live predecessor | `adopt` | `commit` does not call `adoptionGate` |
| `absorb` | the same `executeTransition` | `adoptionGate(false, …)` then `adopt` | Stale check uses `omegaDigest`, not FS1 |
| `reorg` | Replays through `absorb` | Replaces the node collections from the replay | Bulk install has no separate gate |
| `restoreDerived` | Replays stored blocks through `absorb` | The reconstructed node | Stored blocks have no proof field |

`adopt` itself does not build a statement. It installs the stepped state, the block, and finality metadata. The local and external paths call `executeTransition`, and `transitionStatement` reads that execution. `inputId` is the projected input plus structured evidence. `stateRootStateId` is the FS1 taken on the line after `stateRootOf`. A swap timestamp is an unauthenticated copy. The context id still does not name the host ABI. The adoption flag is still false.

The next gap is the host ABI inside the context, and a verifier that does not call `runSuccessor`. The statement now names the execution. It is not yet an authorization.

## What closes each criterion

| Id | Closed when | Not closed by |
| --- | --- | --- |
| C7-A | One relation for `composeBlock`, `commit`, and `absorb`, including nonempty WASM. Failed evidence stays failed. FS1 of all four stages is defined. `inputId` is injective. Host ABI is in the context | Another ledger, or a replay that calls the same function |
| C7-B | The statement's input, context, Ωroot, and predecessor commitments are the bytes the relation actually consumes | A TypeScript type that has the fields |
| C7-C | A verifier accepts one proof of that statement and rejects a changed predecessor, input, context, root, successor, carried state, or header, without calling `successor` | Groth16 of the difficulty law, the reward split, or the stationarity residual |
| C7-D | `adopt` refuses when that verifier has not accepted the statement for this block | A flag that only `absorb` reads |
| C7-E | The installed predecessor's FS1 equals `statement.predecessor` | An `omegaDigest` comparison |
| C7-F | A restored body carries the statement and a verification record that `restoreDerived` checks | Replaying the blocks |
| C7-G | Every path above rejects the altered cases and leaves the node snapshot unchanged | The refusal pins, which cover `applySuccessor` and not `adopt` |

The executor is in place. C7-A stays open until the statement binds that executor's input and context, and until a refused input cannot be adopted through any other installation path. The proof gate is still off, so a unified replay is not yet an authorization.
