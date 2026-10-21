# Stage 1 — U2 through U5

Baseline: `a2742655e75e456d5a13b1953c30dc401453176b`.
The transition was not edited. `omegaDigest`, `stateRootOf`, and `transitionDigest` still commit what they committed. C-007 stays open.

FS1 is a specification encoding in `site/src/protocol/fullstate.ts`. `constitution.ts`, `seal.ts`, `chain.ts`, and `addBlock` do not call it. `site/src/protocol/fullstate.run.ts` is the conformance run.

## Ledger

| Item | Status |
| --- | --- |
| U1 — accepted predecessor domain | Resolved earlier. Relation domain and production boot domain stay different sets. |
| U2 — concrete full-state bytes | Specified. FS1 is the bytes. It is not the header commitment. |
| U3 — helper and execution semantics | Specified from the `applySuccessor` call graph. One order dependence was executed, not inferred. |
| U4 — execution proof vs admission proof | Specified. The circuits and the host replay are different statements. Neither is a proof of the transition checked before adoption. |
| U5 — candidate binding and adoption coverage | Specified. The candidate is named. No adoption path verifies it. |
| C-007 — proof required before forward adoption | Open. |

## U2 — FS1

`Omega` declares 22 fields (`site/src/protocol/constitution.ts`). FS1 writes them in that order, `finalizedHeight` last.

```
"EQFS" || version(1) || record(type=0, fields=22) || field₀ … field₂₁
```

Each value is tagged:

| Tag | Bytes |
| --- | --- |
| 1 | IEEE-754 binary64, little-endian. −0, NaN, and infinities stay distinct. |
| 2 | u32 byte length, then UTF-8 |
| 3 | 0 or 1 |
| 4 | null, no payload |
| 5 | absent, no payload |
| 6 | u32 count, then that many values, in array order |
| 7 | u32 count, then key string and value, in Map insertion order |
| 9 | record type id, field count, then those fields |

Nested record ids: couplings 1, account 2, pool 3, btc header 4, eth header 5, validator 6, delegation 7, unbonding 8, withdrawal 9, execution header 10, proposal 11, ballot 12, model 13, settlement 14.

Rules that the digest does not follow:

- Map insertion order is kept. `omegaDigest` sorts ledger, pools, wasm, and validators.
- Empty and absent are different. `omegaDigest` drops an empty unbonding, withdrawal, or execution tail, and `ethExecution ?? []` collapses a hole with `[]`.
- A field cannot absorb the next field. Lengths end values. The digest joins with `|`, `:`, and `;`.
- Pool `tokenA` / `tokenB` and the validator map key are in the bytes. The digest omits both and relies on `identityError`.
- `tipHash` is in the bytes. `omegaDigest` omits it on purpose; the next header binds it as `prev`.

`fullStateId` is sha256 of those bytes. It is not written into a header.

`decodeOmega` is the inverse. A trailing byte is a refusal. The conformance run round-trips `initialOmega("testnet")` and a −0 coupling.

### What the existing commitments still are

| Commitment | Binds | Does not bind |
| --- | --- | --- |
| `stateRootOf` | Sorted ledger leaves, sorted pool id/reserves/fee/txCount, btc tip, eth tip, sorted wasm, models, settlements | Validators, delegations, unbonding, withdrawals, proposals, couplings, height, difficulty, finality, committee, execution headers, `tipHash` |
| `omegaDigest` | The projection in `constitution.ts`, including conditional tails | `tipHash`. Distinct entry-valid states can share the preimage (below). |
| `transitionDigest` | `tipHash`, `omegaDigest`, a delimiter join of inputs | The predecessor's FS1 bytes |
| Header hash | Sealed outputs: prev, merkle, state root, time, nonce, difficulty, residual fingerprint, miner, height, pressure, and when present chain id, evidence root, omega root, transition root | The predecessor object |

### Collisions the run executed

Both sides of each row pass the entry checks (`monetaryError` is null, and `applySuccessor` does not return an identity or monetary refusal). `omegaDigest` matches. FS1 does not.

| Pair | Also witnessed |
| --- | --- |
| `ethExecution` absent vs `[]` | Digest collapses them. FS1 does not. |
| One delegation whose fields contain `>` and `;` vs two delegations | Same delegation preimage. |
| One unbonding whose fields contain `:` and `;` vs two unbondings | Same unbonding preimage. |
| Settlement `to` carrying `\|` vs a normal settlement plus an unbonding tail | Same predecessor digest. The unbonding side pays `del` 1 at height 3. The settlement side does not. Successor `omegaRoot` differs. |
| `ethPubkey="ab"`, committee `"cd:ef"` vs pubkey `"ab:cd"`, committee `"ef"` | Same committee preimage. Both enter. |
| Wasm `{a: "b\|c=d"}` vs `{a: "b", c: "d"}` | `stateRootOf` matches too, because it uses the same sorted join. |
| Ledger key `a:1:0;b` vs accounts `a` and `b` | `stateRootOf` does **not** match. The digest still does. |
| `blocksProposed` 0 vs 1 | Not a digest collision. Both FS1 and `omegaDigest` change. The field is not optional in a full-state identity. |
| Validator map order `(m2=2, big=2^53−1, jail=2^52 jailed)` vs an order that fails the same quorum test | Same predecessor digest. `applySuccessor` finalizes one and not the other. |

The last row is why a sorted validator list is not a full predecessor. `distribute` pays `floor(staked * stake / total)` per live validator and drops the dust, so that share does not depend on order. The finality ratio does not use `safeAdd`. It is `[...validators.values()].reduce((s, x) => s + x.bondedStake, 0)` over all rows and again over the live rows (`constitution.ts`, the block that sets `finalizedHeight`). Those sums are not associative once they leave the safe-integer range, and entry checks only bound each stake.

### Quotient, stated so it is not silent

FS1 distinguishes some states the relation then collapses:

- `ethCommittee` absent vs `""`, and `ethExecution` absent vs `[]`, because `cloneOmega` and `??` normalize them before a later read.
- Ledger insertion order, for key-addressed credits. The successor map still carries the order, so FS1 of the successor differs, but no numeric field of this relation changes because of it.
- Coupling −0 vs 0 under `===` and `num()`. FS1 keeps the sign bit. The run round-trips −0.

A proof that claims FS1 equality is stricter than the relation. A proof that claims only the relation may quotient those three. It may not quotient validator order, delegation order, proposal order, or the tail pairs above.

## U3 — what the relation actually does

`applySuccessor` is the relation. `successor` is the only caller that may attach a `DerivedWasm`, and only after `executeWasm`. A caller-supplied map in `CanonicalInputs.wasmAfter` is not read.

Order of the relation, from the source:

1. Known `chainId`, else `"unknown chain"`. Parameters come from `NETWORKS`, not from Ω.
2. Nonce is a u64.
3. `monetaryError`, then `identityError`.
4. Claimed difficulty equals Ω. Pressure is finite and inside `[0,1]`. Timestamp is a non-negative safe integer and, after height −1, at least `tipTimestamp`.
5. Every transaction passes `verifyTx` before any mutation.
6. The list is no longer than `maxTxPerBlock`, and it equals `selectSuccessorTxs` on the pre-state balances (reference equality of the tx objects).
7. `cloneOmega`, then `openOmega`. Passed proposals write couplings in array order; the last passed proposal for a key wins. Claimed couplings must be those opened couplings.
8. Miner is a live validator with positive stake. The authority snapshot for stake ops is taken here, before those ops.
9. `applyMaterial`, in evidence order: stake, btc headers, eth committee or headers, settlements, withdrawals. Each refusal aborts the whole step. Btc and eth execution windows drop from the front at 2016 and 256.
10. If `evidence.wasm` is non-empty, storage becomes the `DerivedWasm` map. Otherwise storage is untouched.
11. Residual from `evaluateResidual` under ECMA-262, over prev hash, tx merkle, timestamp, nonce, difficulty, opened couplings, `max(0, height+1)` as work, and the committed pressure. Admission `R < threshold` is not inside this function.
12. Reward is `floor(minerReward(...))`. Liquid is `floor(reward * commission)` when the miner is live; the rest is the staked residual. A slash earlier in this same step is already on the validator the split reads.
13. `applyEffects` in list order. A pool hit is the first pool whose address equals `tx.to`. The selector is run again after fees land; a list that only became canonical because of an intra-block credit is refused.
14. `admitModels`, then matured unbondings, then matured withdrawals. Maturity uses the successor height.
15. `stateRootOf` of that pre-bookkeeping state. `admitBinding` may refuse if a cognition bind string is not `residualBinding(canonicalFp, stateRoot)`.
16. Miner `blocksProposed` increments. `distribute` pays the staked residual. Monetary and identity checks run again.
17. Height, timestamp, difficulty, and maybe `finalizedHeight` move. `omegaDigest` is taken after that. `tipHash` does not move here. `sealFromSuccessor` sets it to the header hash on the carried Ω.

`callArbitrage` returns sorted storage pairs. `executeWasm` ignores that array and returns the Map the host mutated. Later wasm reads are `storage.get` / `storage.set`. The sorted view is not the successor.

Numeric model is ECMA-262, including `Math.pow` in the reward curve, the float residual, and the unsorted finality sum. `residualFp` is `floor(R × 1e18)`, or −1 when R is not a finite non-negative number.

## U4 — two proofs that are not this relation

Execution proof, the thing C-007 asks for: a verifier checks that this predecessor, these inputs, and this wasm host trace produce this successor, without re-executing the host. The predecessor in that statement is FS1, not `omegaDigest`.

Admission proof, what the repo has:

| Artifact | What it constrains | What it does not |
| --- | --- | --- |
| `stationarityRelation` | Header residual fingerprint, threshold, and that the hash splits into two 8-byte limbs | That `applySuccessor` produced the header |
| `StationarityCircuit` | `residual + difference = threshold` and `difference ≠ 0` in the field. Hash limbs are public inputs and unused | The transition |
| `SkeletonCircuit` | Height + 1, a u64 time delta, one balance + liquid, the same residual inequality. Digest limbs are public and unused. The file says it is not a proof of `applySuccessor` | Reward, pools, difficulty, stake, the rest of Ω |
| `admitBinding` / `residualBinding` | The host recomputed `sha256("eq-bind\|fp\|stateRoot")` | A circuit, or the predecessor |
| `absorb`, `commit`, `installCanonical` | The host ran the relation and the claimed roots match | A proof. Replay is the check |

`addBlock` says the stationarity statement is not `applySuccessor`. A live block whose proof does not bind has the proof dropped and can still be admitted. A restored block whose proof does not bind is refused. That is a check that a stored proof matches a header, not a check that the transition happened inside a circuit.

## U5 — the candidate, and who adopts without it

The candidate a future proof has to bind, before `adopt` or `installCanonical` assigns the successor:

- FS1 of the predecessor, which already includes `tipHash`
- the inputs the relation read: ordered transactions (full tx, not only the six digest fields), evidence in list order, timestamp, the u64 nonce, miner, committed pressure, couplings, difficulty
- when `evidence.wasm` is non-empty, the host trace from `executeWasm`, not a caller map
- FS1 of the successor **before** the sealed `tipHash` is written back, plus the returned state root, omega root, reward, liquid, residual, residual fingerprint
- the header hash from `sealFromSuccessor`, which is an output

`transitionDigest` is not this binding. It hashes `omegaDigest` and a delimiter join.

| Path | What it does | Covered by an execution proof today |
| --- | --- | --- |
| `OrganismNode.absorb` | `successor()` then root and residual checks, then `adopt` | No. Host replay. This is the path a proof would have to precede. |
| `commit` (local mine) | `applySuccessor` with no `DerivedWasm`. Wasm evidence therefore refuses. `wasmAfter` is ignored | No |
| `installCanonical` / `addBlock` | `applySuccessor`, not `successor()`. Couplings are replaced with `openedCouplings` before the call. Stationarity proof is not required to admit | No |
| `restoreDerived`, and `restoreNode` when a saved body has blocks | Replay through `absorb` from `constitute`. Saved accounts are not copied over the replay | No. It is the production site boot, and it is still replay |
| `OrganismNode.restore` | Copies the persisted body, including models and settlements | No. Not replay |
| `reorg` | Replays on a side body, then copies every canonical field except `models` and `settlements` | No. The installed Ω is not the replayed Ω |
| `importRestartSnapshot` | Assigns ledgers, stakes, and `omegaFromRecord` with no successor check | No |

Production boot being replay-derived does not shrink `applySuccessor`'s entry domain, and it does not put a proof in front of `adopt`.

## What this does not close

- C-007. Nothing verifies FS1, or a proof of the relation, before adoption.
- A guest. FS1 is the statement's predecessor. It is not a circuit.
- Input bytes of the same strength as FS1. The predecessor side is the part the collision run covers. `canonicalEvidence` is still a delimiter join.
- The reorg hole. Naming it is not a patch.
