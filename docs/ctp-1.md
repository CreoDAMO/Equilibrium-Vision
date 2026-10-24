# CTP-1

Complete Transition Proof Specification

Status: specification only. No proof system implements this document. `verifyTransitionProof` rejects every proof. Adoption does not call it. C-007 is open.

Reference interpreter described here: `applySuccessor` and `successor` in `site/src/protocol/constitution.ts`, as of `0050a84`. The byte-level relation is [CTP-1 Relation](ctp-1-relation.md). That document wins where this one describes a commitment. Statement bytes already produced by the program: version 1 in `site/src/protocol/transition-proof.ts`. Those bytes are a partial encoding of section 4. They are not this specification.

If this document is silent, the case is undefined, and no proof of it may be accepted. If this document and the interpreter disagree, neither one closes C-007.

## 1. Claim

A canonical successor is admissible only with a proof of one statement:

\[
\begin{aligned}
\Omega_{\mathrm{pre}} &= \mathrm{FS1}^{-1}(\textit{predecessor}) \\
I &= \mathrm{Inputs}^{-1}(\textit{inputs}) \\
C &= \mathrm{Context}^{-1}(\textit{context}) \\
\mathrm{Reference}(\Omega_{\mathrm{pre}}, I, C) &= (\Omega_{\mathrm{rel}}, \textit{roots}, H) \\
\Omega_{\mathrm{carried}} &= \Omega_{\mathrm{rel}}[\,\mathrm{tipHash} \mapsto H\,] \\
\textit{stmt} &= \mathrm{Commit}(\Omega_{\mathrm{pre}}, I, C, \Omega_{\mathrm{rel}}, \Omega_{\mathrm{carried}}, \textit{roots}, H)
\end{aligned}
\]

`Reference` is section 6. `Commit` is section 4. A proof of any proper subset is not a proof of CTP-1.

## 2. Model

The numeric model is ECMA-262, the model named `NUMERIC_MODEL` in the reference interpreter. In particular:

- IEEE-754 binary64, round-to-nearest-even, including \(+0\), \(-0\), NaN, and the infinities.
- `Object.is` distinguishes \(-0\) from \(+0\). `String(-0)` and the digest helper `num` do not.
- Map and array order are the order of the object, not a sort, except where section 6 names a sort.
- A JavaScript number is not a `u64`. The block nonce is a bigint in \([0, 2^{64}-1]\).
- Floor division is `Math.floor` of an ECMA-262 division. Dust from that floor is destroyed, not assigned.

A proof that substitutes rational arithmetic, a sorted validator set, or a different rounding mode is a proof of a different relation.

The wasm program is the bytecode whose SHA-256 is `ARBITRAGE_CODE`. No other program is `C`.

## 3. Objects

\(\Omega\) is one state in the FS1 domain of version 1: magic `EQFS`, version byte `1`, record type `0`, declaration order, map insertion order, absent distinct from empty. `fullStateId(Ω) = SHA-256(FS1(Ω))`.

`omegaDigest(Ω)` is a different function. It sorts some maps, collapses \(-0\), and omits optional tails when they are empty. It is not the predecessor and not the successor.

\(I\) is one `CanonicalInputs` value: the ordered transaction list, the evidence object, the timestamp, the nonce, the miner, the committed pressure, the couplings, the difficulty, and `wasmAfter`. The mempool is not an element of \(I\).

\(C\) is the network parameter record selected by `paramsOf(Ω.chainId)`, the numeric-model name, and `ARBITRAGE_CODE`. Chain id alone is not \(C\). Mainnet and testnet are different contexts.

Three states are produced by one successful transition. They are not aliases.

| State | When it exists | What it excludes |
| --- | --- | --- |
| \(\Omega_{\mathrm{root}}\) | The instant `stateRootOf` is called | Later `blocksProposed`, staking distribution, height, timestamp, difficulty, finality |
| \(\Omega_{\mathrm{rel}}\) | The value returned as `next` | The new header. `tipHash` is still the parent's |
| \(\Omega_{\mathrm{carried}}\) | The state the next block reads | Nothing in \(\Omega_{\mathrm{rel}}\) except `tipHash = H` |

`stateRoot` is a Merkle root of a projection of \(\Omega_{\mathrm{root}}\): ledger, pools, bitcoin headers, ethereum headers, wasm, models, settlements. It is not FS1. Its ledger leaf does not use the digest helper that preserves the sign of zero. Its settlement leaf is colon-delimited and not injective.

`omegaRoot` is `omegaDigest(Ω_rel)`, computed after height, timestamp, difficulty, finality, `blocksProposed`, and staking distribution. It is not `fullStateId(Ω_rel)`.

## 4. Public statement

The public input is the whole statement. There is no private input in the statement itself. A witness may be private. The statement may not.

Version 1 bytes, already implemented, are the concatenation under magic `EQTP` and version byte `1` of length-prefixed fields, in this order:

`numericModel`, `predecessor`, `inputId`, `contextId`, `stateRoot`, `omegaRoot`, `successor`, `carried`, `evidenceRoot`, `transitionRoot`, `header`, `residualFp`, `wasm`.

The statement identifier is SHA-256 of those bytes.

The fields mean:

| Field | Required value |
| --- | --- |
| `predecessor` | `fullStateId(Ω_pre)` |
| `inputId` | SHA-256 of the version-1 input encoding |
| `contextId` | SHA-256 of the version-1 context encoding |
| `stateRoot` | `stateRootOf(Ω_root)` |
| `omegaRoot` | `omegaDigest(Ω_rel)` |
| `successor` | `fullStateId(Ω_rel)` |
| `carried` | `fullStateId(Ω_carried)` |
| `evidenceRoot` | The evidence root inside \(H\) |
| `transitionRoot` | `transitionDigest(Ω_pre, I)`, which commits `omegaDigest(Ω_pre)`, not FS1 |
| `header` | \(H\), the seal hash |
| `residualFp` | The decimal text of the canonical residual fixed point the relation returned |
| `wasm` | `ARBITRAGE_CODE` |

\(H\) is `canonicalHeaderHash` of the parent hash, the transaction Merkle root, `stateRoot`, the timestamp, the nonce, the difficulty, the residual fixed point, the miner, the next height, the committed pressure, the evidence chain id, `evidenceRoot`, `omegaRoot`, and `transitionRoot`. The new tip hash is not an input to `omegaDigest`. Writing it back into that digest would be circular. FS1 of \(\Omega_{\mathrm{carried}}\) is where it is bound.

### 4.1 What version 1 does not yet bind

These omissions are part of the specification. An implementation that proves only the version-1 bytes, and not the repairs below, has not proved CTP-1.

1. `contextId` does not bind an identity of this relation. Two interpreters can share a context id.
2. The version-1 input encoding hashes `canonicalEvidence`. That string is not injective. A proof of `inputId` does not separate colliding evidence.
3. `transitionRoot` still commits `omegaDigest(Ω_pre)`. The predecessor field commits FS1. Both are public. They are not required to determine each other.
4. No field is `fullStateId(Ω_root)`. `stateRoot` is not a substitute.
5. The numeric model is a name, not a pinned engine.

Until those are repaired, the statement identifier is a commitment to a quotient of the transition. Section 6 is still the relation. The bytes are not a license to prove the quotient and stop.

## 5. Witness

A witness of a successful transition contains at least:

- \(\Omega_{\mathrm{pre}}\), \(I\), and \(C\), opening the three public commitments.
- The wasm execution trace, if `I.evidence.wasm` is non-empty: program `ARBITRAGE_CODE`, storage before, each call in order, storage after. A caller-supplied map is not a witness. Only execution inside `successor` produces `DerivedWasm`.
- The intermediate \(\Omega_{\mathrm{root}}\) and \(\Omega_{\mathrm{rel}}\), opening `stateRoot`, `omegaRoot`, `successor`, and `carried`.
- The refusal checks of section 6, each shown false.
- The header preimage, opening \(H\).

A witness of a refusal is not a CTP-1 witness. Refused transitions are not adopted.

The witness may be private. Anything the adoption rule compares to the installed block must be public, and is already in section 4.

## 6. Reference relation

Let `Reference(Ω, I, C)` be the following order. It is one execution of `applySuccessor`, after wasm execution when the evidence contains wasm calls. It is not a second call to `applySuccessor` after `successor`, because `successor` already calls `applySuccessor`. A proof may not reorder it. `I.wasmAfter` is not read.

1. If `I.evidence.wasm` is non-empty, execute `ARBITRAGE_CODE` on a copy of `Ω.wasm`, calls in array order, block number `max(0, Ω.height)`. A failing call refuses. The resulting map is the only admissible derived storage. `I.wasmAfter` is not that map. The reference passes `wasmAfter: null` into the next step.
2. Refuse unless `paramsOf(Ω.chainId) = C`'s parameter record.
3. Refuse unless the nonce is a `u64`.
4. Refuse if `monetaryError(Ω)` or `identityError(Ω)` is set. These predicates apply to the predecessor that was presented, not to an arbitrary restored object outside the relation.
5. Refuse unless `I.difficulty = Ω.difficulty`, pressure is in \([0,1]\), and the timestamp is a safe non-negative integer, monotonic when `Ω.height ≥ 0`.
6. Refuse unless every transaction verifies under `Ω.chainId`. Verification covers the signature preimage: sender, recipient, amount, fee, nonce, public key, chain id. The timestamp is not in that preimage. It is still an input, and step 15 reads it for a swap.
7. Refuse unless the transaction list is the canonical selection of itself under the predecessor balances, nonces, the pool-address exclusion, and `C.maxTxPerBlock`. Order is significant. Equality is reference order of that selection, not a re-sort.
8. Clone. The predecessor is not mutated.
9. `openOmega` on the clone, in proposal order. Passed proposals write couplings and become executed. Refuse unless `I.couplings` equals the opened couplings.
10. Refuse unless the miner is a live validator: present, not jailed, not slashed, bonded stake positive. Lookup is by the miner string.
11. `applyMaterial` in its category order. Evidence array order is kept. A material error refuses.
12. If wasm calls were present, replace wasm storage with the map from step 1. Otherwise leave the cloned storage.
13. Evaluate the residual from the header skeleton, the transaction hashes and fees, the cumulative work `max(0, height+1)`, the committed pressure, and the opened couplings. The residual fixed point is the one the interpreter returns, not a claimed residual.
14. Reward is the floored halving schedule of \(C\) at the next height, scaled by the residual quality. Issuance splits liquid miner reward from the staking remainder by the interpreter's rule. Floors are part of the relation.
15. `applyEffects` in list order: signature-independent debits, nonces, fees, swaps, and the liquid credit. A transaction to a pool address is a swap. A swap whose quoted output floors to zero still debits the sender and credits the fee, leaves the pool unchanged, and emits no swap event. An effect error refuses.
16. The canonical-selection check of step 7 is repeated after effects. A list the selector would not emit is refused even if the effects could apply it.
17. `admitModels`. A model error refuses.
18. `settleMaturedUnbondings`, then `refundMaturedWithdrawals`, at the next height, in list order. An error refuses.
19. \(\Omega_{\mathrm{root}}\) is this state. `stateRoot = stateRootOf(Ω_root)`. Binding admission either refuses or leaves this root unchanged.
20. Increment `blocksProposed` for the miner.
21. `distribute` the staking remainder across live validators in map iteration order. Each share is floored. Undistributed dust is not paid. An overflow refuses.
22. Refuse if monetary or identity error is now set.
23. Write height, timestamp, and difficulty. Difficulty uses the parent difficulty, the block interval, \(C\), and the foreign-difficulty factor of this state. At height 0 the interval is the parameter target, not a timestamp delta.
24. Finality reads validator map order. Raw sums, then one division. If `voting / total ≥ C.finalityQuorum`, finalized height becomes `max(finalizedHeight, height − finalityLag)`.
25. \(\Omega_{\mathrm{rel}}\) is this state. `omegaRoot = omegaDigest(Ω_rel)`. `tipHash` has not changed.
26. Seal \(H\) from \(\Omega\), \(I\), and the roots. \(\Omega_{\mathrm{carried}}\) is \(\Omega_{\mathrm{rel}}\) with `tipHash` replaced by \(H\).

A step that the interpreter refuses has no \(\Omega_{\mathrm{rel}}\) and no proof obligation. Adoption of a refused step is non-conformant.

Helpers named above and not expanded field-by-field are obligations of section 13. A proof may not replace an unexpanded helper with "the hash matched."

## 7. Proof system

CTP-1 does not name Groth16, a STARK, or a signature as the system. The stationarity proof and the successor skeleton already in the repository are not CTP-1. They may be subroutines only under section 8.

A system \(\Pi\) conforms only if it provides:

- `Prove(witness) → π`, deterministic given the witness and the public statement.
- `Verify(stmt, π) → accept | reject`, deterministic, and independent of who mined the block.
- The statement bytes of section 4, after the repairs of section 4.1, as the only public input that `Verify` accepts.

`Verify` on a malformed statement rejects. `Verify` on a proof for a different statement rejects. There is no alternate acceptance path.

## 8. Composition

A hybrid proof is one proof. It is a list of component proofs together with a binding proof whose public input is the CTP-1 statement.

The binding proof accepts only if:

- each component verifies under its own public input,
- those public inputs are the intermediate commitments of this witness, in the order of section 6,
- the first intermediate opens `predecessor`, and the last opens `successor`, `carried`, and \(H\),
- no component public input can be replaced without changing the CTP-1 statement identifier.

Separately verified components, each true of some witness, are not a proof of the conjunction. Stationarity of \(H\) does not prove section 6. A replay that produces the same roots does not prove section 6.

## 9. Soundness

The requirement, relative to section 6 and to the collision resistance of SHA-256, is:

If `Verify(stmt, π)` accepts, then there exist \(\Omega_{\mathrm{pre}}\), \(I\), \(C\) such that `Reference` accepts, and section 4's fields are exactly the values that execution produced.

Knowledge soundness is required: an accepting proof is extractable to such a witness.

Completeness is required only for accepting executions of section 6. Honest `Prove` on that witness must be accepted. Refusals need not have proofs.

A break of SHA-256, or a different numeric model than section 2, is outside the claim. An engine that disagrees with the pinned ECMA-262 reference is a different relation, not a counterexample.

## 10. Adoption

Let the parent already be canonical, with state \(\Omega_{\mathrm{pre}}\) and header hash \(P\).

Installing a claimed successor is conformant if and only if all of the following hold:

- `Verify(stmt, π)` accepts.
- `stmt.predecessor = fullStateId(Ω_pre)`.
- `Ω_pre.tipHash = P`.
- `stmt.header` equals the claimed block hash.
- The claimed `stateRoot`, `omegaRoot`, `evidenceRoot`, and `transitionRoot` equal the statement.
- The state installed for the next block is the unique \(\Omega_{\mathrm{carried}}\) with `fullStateId` equal to `stmt.carried`.
- The parent is not replaced by a block at or below its finalized height.

Otherwise the claim is refused. Replay, a stationarity check, a matching digest, or a seal over an unproved candidate is not a substitute.

The paths this rule covers, and from which the substitute must be removed:

- local mining, from `commit` through `installNext`,
- gossip and external admission, from `proveCandidate` through `absorb`,
- reorganization replay,
- API `commitEvidence`, `commitOperational`, and `adoptReplay`,
- restart from stored blocks, before a stored successor becomes canonical again.

Persistence of a row is not adoption. A stored block that cannot be verified under this rule is not canonical after the rule is in force. How a chain that already adopted unverified history crosses that line is a migration, and it is not defined here. It is not an exception inside `Verify`.

`ADOPTION_REQUIRES_TRANSITION_PROOF` is false. Production at `f71ca06` does not implement this section.

## 11. What is not a proof of CTP-1

- A stationarity proof of residual, threshold, and header limbs.
- The integer successor skeleton.
- `omegaDigest` equality.
- FS1 equality of the endpoints with no proof of section 6.
- Deterministic replay by the same interpreter.
- A signature checked at an API gate and then omitted from the block.
- A slash reason with no proof of the fault.
- A wasm caller checked at the gate and carried only as a string.
- A nonce search.
- This document.

## 12. Obligations before an implementation can conform

1. Pin the numeric engine, or define the ECMA-262 fragment section 6 actually uses, including \(-0\) and the non-injective `num` helper, as part of the relation rather than as an accident.
2. Give \(C\) an identity that changes when section 6 changes.
3. Replace the evidence string inside the input commitment with an injective encoding. The relation stays on the structured evidence. The old string may remain inside `transitionRoot` only as a legacy header field, and the statement must show that it is legacy.
4. Expand `applyMaterial`, `applyEffects`, `applySwap`, `admitModels`, settlement, unbonding, and the monetary and identity predicates to the same grain as section 6. Until that expansion, a circuit of the names is not a circuit of the functions.
5. Bind `fullStateId(Ω_root)` in the statement, or prove `stateRoot` from that FS1 inside the relation. Binding the root string alone is not enough, because the root is not injective.
6. Treat map iteration order as consensus for distribution and finality. A proof that sorts those maps is rejected.
7. Prove wasm by execution under `ARBITRAGE_CODE`, inside the same statement as the state transition.
8. Show conformance on accepting executions and on adversarial refusals: colliding digests, reordered evidence, a forged derived wasm map, a swapped validator iteration order, a zero-output swap, a non-`u64` nonce, and a proof for a different statement.
9. Call `Verify` at every path in section 10, with no fallback, and set the adoption flag from that change.

None of these nine is done.

## 13. Conformance of this repository

| Requirement | At `f71ca06` |
| --- | --- |
| Section 4 bytes, partial | Implemented. Not the repaired statement |
| Section 6 as the interpreter | Implemented as the program, not as a proved relation |
| Section 7 | Absent. Every proof is rejected |
| Section 8 | Absent |
| Section 9 | Not met |
| Section 10 | Not met. The flag is off |

C-007 closes only when sections 7 through 10 hold for the repaired statement, under section 9, on the paths in section 10. This document does not close it.
