# CTP-1 Relation

Formal specification of the production transition relation.

Status: relationship only. Not a proof system. Not enforced. C-007 is open.

This document defines when a successor is the result of the production transition. It does not choose a proving system. Where a commitment byte string is specified, this document is the authority. [CTP-1](ctp-1.md) remains the authority for what a proof of this relation must do at adoption.

The interpreter is `applySuccessor` in `site/src/protocol/constitution.ts`, with wasm execution performed only by `successor` in the same file, as of `0050a84`. A cleaner arithmetic model is a different relation.

## 1. Rule

A successor is valid if and only if it is the exact result of `Reference` on the exact predecessor, the exact ordered inputs, and the exact protocol context.

\[
\begin{aligned}
\mathrm{ValidTransition}
(\Omega_{\mathrm{pre}}, I, C,\ \Omega_{\mathrm{rel}}, R_s, R_\omega, R_e, R_t, H)
&\iff \\
\mathrm{Reference}(\Omega_{\mathrm{pre}}, I, C)
&= (\Omega_{\mathrm{rel}}, R_s, R_\omega, R_e, R_t, H)
\end{aligned}
\]

Internal consistency of the claimed outputs is not enough. They must be the outputs of this function.

The symbols below are not interchangeable.

| Symbol | Meaning |
| --- | --- |
| \(\Omega_{\mathrm{pre}}\) | Predecessor state, before the transition |
| \(B_{\mathrm{pre}}\) | FS1 bytes of that state |
| \(I\) | Ordered inputs the transition reads |
| \(C\) | Protocol context |
| \(\Omega_{s}\) | State at the `stateRootOf` call |
| \(\Omega_{\mathrm{rel}}\) | State `applySuccessor` returns |
| \(\Omega_{\mathrm{carried}}\) | \(\Omega_{\mathrm{rel}}\) with `tipHash` replaced by \(H\) |
| \(R_s\) | `stateRoot` |
| \(R_\omega\) | `omegaRoot` |
| \(R_e\) | `evidenceRoot` |
| \(R_t\) | `transitionRoot` |
| \(H\) | Sealed header hash |

\[
\Omega_{\mathrm{pre}} \neq \Omega_{s} \neq \Omega_{\mathrm{rel}} \neq \Omega_{\mathrm{carried}}
\]

is the normal case. A proof that collapses any two of them does not state this relation.

## 2. What the program actually calls

`successor(Ω, I₀)` executes wasm, if the evidence contains wasm calls, and then calls `applySuccessor` once. It forces `wasmAfter` to null. It does not return a header.

`applySuccessor(Ω, I, derived)` is the state transition. It does not execute wasm. If the evidence contains wasm calls, `derived` must be the storage just executed. Otherwise the transition refuses. The field `I.wasmAfter` is never read.

`sealFromSuccessor(Ω, I, stepped)` computes \(R_e\), \(R_t\), and \(H\) from a successful step. It does not re-run the transition.

Local block production does not use that as one call. `composeBlock` calls `applySuccessor` directly, with no `derived`. If that call refuses for any reason, it replaces the evidence with blank evidence, clears the pending wasm map, and calls `applySuccessor` again. The sealed block carries the inputs of the call that succeeded, which may not be the inputs that were queued. That retry is a production policy. It is not part of `Reference`.

Incoming adoption calls `successor`, not `applySuccessor`, and does not retry.

Therefore:

- The relation of a sealed block is `Reference` on the inputs inside that block.
- A discarded first attempt is not the relation of the block.
- A host-supplied storage map is not a witness. `dependencies` already records that `applySuccessor` refuses one.

`Reference` is not \(\mathrm{Seal} \circ \mathrm{ApplySuccessor} \circ \mathrm{Successor}\). That composition calls the state transition twice, because `successor` already contains it.

\[
\mathrm{Reference}
= \mathrm{Seal}\bigl(\mathrm{ApplySuccessor}(\Omega_{\mathrm{pre}}, I[\mathrm{wasmAfter}\mapsto \mathrm{null}], D)\bigr)
\]

\(D\) is the storage map from section 5 when the evidence contains wasm calls, and absent otherwise.

## 3. Predecessor

\[
B_{\mathrm{pre}} = \mathrm{FS1}(\Omega_{\mathrm{pre}}), \qquad P = \mathrm{SHA256}(B_{\mathrm{pre}})
\]

FS1 version 1 is the byte string `encodeOmega` writes.

- Magic `EQFS`, version byte `1`.
- One record, type `0`, field count `22`, little-endian lengths.
- Tags: `f64` `1`, `string` `2`, `bool` `3`, `null` `4`, `absent` `5`, `list` `6`, `map` `7`, `record` `9`.
- A `f64` is the IEEE-754 little-endian bits, including the sign of zero.
- Map entries are in insertion order. They are not sorted.
- Absent is a different tag from an empty list or an empty string.

The 22 fields, in order, are: `chainId`, `height`, `tipHash`, `tipTimestamp`, `difficulty`, `couplings`, `ledger`, `pools`, `btc`, `ethPubkey`, `ethCommittee`, `eth`, `wasm`, `validators`, `delegations`, `unbonding`, `withdrawals`, `ethExecution`, `proposals`, `models`, `settlements`, `finalizedHeight`.

`ethCommittee` and `ethExecution` are holes. Missing and empty are different byte strings. `omegaDigest` collapses that difference. FS1 does not.

\(P\) commits to \(B_{\mathrm{pre}}\). It does not contain \(B_{\mathrm{pre}}\). A checker of this relation must have the bytes and must check the hash. An `omegaDigest` comparison does not establish \(P\).

## 4. Inputs

\(I\) is the value `applySuccessor` reads:

- the ordered transaction array,
- the evidence object, or its absence,
- the timestamp, the `u64` nonce, the miner, the committed pressure, the couplings, and the difficulty.

`wasmAfter` is not an element of \(I\). Version 1 of `encodeInputs` still hashes it. That encoding is not `CommitInputs`. Two maps that differ only there are the same input to this relation and different version-1 statement identifiers.

Transactions are read in array order. The fields the relation can observe are the hash, sender, recipient, amount, fee, nonce, timestamp, status, signature, public key, block hash, and block height. The signature preimage is only sender, recipient, amount, fee, nonce, public key, and chain id. The timestamp is outside that preimage and inside the swap path. Both facts are part of the relation.

Evidence is the object, in category order, not the canonical string. The string is a projection used by \(R_t\) and \(R_e\). It is not injective. Distinct evidence objects can share it, and `applyMaterial` can still tell them apart. A commitment to the string is not a commitment to \(I\).

`CommitInputs` for this relation is not yet a function in the program. It must be injective on the objects above, preserve array order, and omit `wasmAfter`. The version-1 input bytes now omit `wasmAfter`. They still hash `canonicalEvidence`, so they are still not `CommitInputs`.

## 5. Context and wasm

\(C\) is `paramsOf(Ω.chainId)`, the name `ECMA-262`, and the wasm bytecode whose SHA-256 is `ARBITRAGE_CODE`.

`paramsOf` returns the mainnet record for chain id `1` and the testnet record for chain id `2`. Anything else refuses. The records differ at least in chain id, block interval, residual threshold, and whether the faucet is enabled. Chain id alone is not \(C\).

`C` does not yet include an identity of this document or of `applySuccessor`. Two different interpreters can share the version-1 context hash. That hash is not the identity of \(C\) required here.

If `I.evidence.wasm` is empty, \(D\) is absent and wasm storage is the cloned predecessor storage.

If it is not empty, \(D\) is the storage after `callArbitrage` on a copy of the predecessor wasm map, calls in array order, block number \(\max(0, \Omega.\mathrm{height})\), program `ARBITRAGE_CODE`. A call that does not return code `1` refuses. No other map is \(D\).

`applyMaterial` also refuses unless `evidence.wasmCode` equals `ARBITRAGE_CODE`. The bytecode hash in the evidence and the bytecode that was executed are both constrained. Neither constraint is a proof of the execution trace by itself.

## 6. The function

On \((\Omega_{\mathrm{pre}}, I, C)\), with \(D\) from section 5, the function refuses or returns as follows. The order is the order of the reads and the writes.

1. Refuse if \(C\) is not the parameter record for `Ω.chainId`.
2. Refuse unless the nonce is an integer in \([0, 2^{64}-1]\), held as a bigint.
3. Refuse if `monetaryError(Ω_pre)` or `identityError(Ω_pre)` is set.
4. Refuse unless difficulty matches the predecessor, pressure is finite and inside \([0,1]\), and the timestamp is a non-negative safe integer. If the predecessor height is at least `0`, the timestamp must be at least the predecessor tip timestamp.
5. Refuse unless every transaction passes `verifyTx` for the predecessor chain id.
6. Refuse unless the transaction array is the canonical selection of itself under predecessor balances and nonces, the pool-address test, and `C.maxTxPerBlock`. Selection order is significant.
7. Clone. The predecessor object is not written.
8. Execute passed proposals in array order. A passed proposal with a finite coupling value writes that coupling, floored at `0`, and becomes `executed`. Refuse unless `I.couplings` equals the couplings after this pass.
9. Refuse unless the miner is in the validator map, not jailed, not slashed, and has positive bonded stake.
10. If evidence is absent, material is a no-op. Otherwise refuse unless evidence version is `1`, the evidence chain id equals the state chain id, and the evidence wasm code equals `ARBITRAGE_CODE`. Then apply, in this order, each array in its own order: stake, bitcoin headers, ethereum operations, settlements, withdrawals. Cognition evidence is not applied here.
11. If wasm calls are present, replace wasm storage with \(D\). If they are present and \(D\) was not executed, refuse. If they are absent, leave the cloned storage. Do not read `wasmAfter`.
12. Let the next height be `Ω.tip height + 1`. Evaluate the residual from the parent hash, the transaction Merkle root, the timestamp, the nonce, the difficulty, the transaction fees, cumulative work \(\max(0, \mathrm{height})\), the committed pressure, and the opened couplings. The residual is the value `evaluateResidual` returns.
13. The reward is the floored halving schedule of \(C\) at that height, scaled by the residual. The liquid portion is the interpreter's split of that reward. Floors are part of the result.
14. Apply transaction effects in array order, including the liquid credit. A transaction whose recipient is a pool address is a swap. A swap whose output floors to zero still debits the sender and credits the fee, does not change the pool, and does not emit a swap. An effect error refuses.
15. Repeat the selection check of step 6. A list the selector would not have emitted is refused even if step 14 could apply it.
16. Admit cognition and model evidence. An error refuses. This is the consumer of cognition evidence, not step 10.
17. Settle matured unbondings, then refund matured withdrawals, at the next height, in list order. An error refuses.
18. \(\Omega_{s}\) is this object. \(R_s = \mathrm{StateRoot}(\Omega_{s})\). Binding admission may refuse. It does not change \(\Omega_{s}\) before the root is taken.
19. Add one to the miner's `blocksProposed`.
20. Distribute the staking remainder across live validators in map-iteration order. Each share is floored. Dust is not paid. An overflow refuses.
21. Refuse if monetary or identity error is set on this object.
22. Write the next height and the timestamp. Write the adjusted difficulty from the parent difficulty, the interval, \(C\), and the foreign-difficulty factor of this object. At a predecessor height below `0`, the interval is the parameter target, not a difference of timestamps.
23. Finality uses map-iteration order. Sum every bonded stake, sum the live bonded stake, and divide. If the ratio is at least `C.finalityQuorum` and `height − C.finalityLag` is greater than the current finalized height, write that cutoff.
24. \(\Omega_{\mathrm{rel}}\) is this object. Its `tipHash` is still the parent's. \(R_\omega = \mathrm{OmegaDigest}(\Omega_{\mathrm{rel}})\).
25. Compute \(R_e\), \(R_t\), and \(H\) by section 8 from \(\Omega_{\mathrm{pre}}\), \(I\), and this step. \(\Omega_{\mathrm{carried}}\) is \(\Omega_{\mathrm{rel}}\) with only `tipHash` replaced by \(H\).

A refusal has no \(\Omega_{\mathrm{rel}}\) and no header. It is not a valid transition.

Steps 10, 14, 16, and 17 name helpers whose field-level effects are not all restated here. Stake, transaction effects, the residual, the reward, and the wasm host are specified in [CTP-1 Bodies](ctp-1-bodies.md). The commentary is [CTP-1 Helpers](ctp-1-helpers.md). The others remain names. A circuit of an unspecified name is not a circuit of the function.

## 7. Commitment timing

\(R_s\) is taken at step 18, before steps 19 through 23.

\(R_\omega\) is taken at step 24, after those writes, while `tipHash` is still the parent hash.

\(H\) binds both roots. It is not inside either root.

\[
\Omega_{\mathrm{carried}} = \Omega_{\mathrm{rel}}[\mathrm{tipHash} \mapsto H]
\]

No other field changes in that assignment.

## 8. Commitment bytes

Strings are UTF-8. `SHA256` is SHA-256. `SHA256d` is SHA-256 of SHA-256. The decimal text of a number is ECMA-262 `String`, except where a function below names another conversion. `num(x)` is `String(x)` for a finite number, and `"0"` when `Object.is(x, -0)`, and `"nan"` otherwise.

### 8.1 State root

`StateRoot(Ω_s)` is the Merkle root of these leaves, in this order:

1. One leaf per ledger entry, entries sorted by address, each `SHA256` of `address:balance:nonce`. This text uses `String` on the balance, so `-0` and `0` meet.
2. One leaf per pool, pools sorted by id, each `SHA256` of `pool:id:address:num(reserveA):num(reserveB):num(fee):txCount`.
3. `SHA256` of `btc:` plus the bitcoin leaf.
4. `SHA256` of `eth:` plus the ethereum leaf.
5. `SHA256` of `wasm:` plus the wasm leaf.
6. `SHA256` of `models:` plus the model leaf.
7. `SHA256` of `settle:` plus the settlement leaf.

The settlement leaf joins `id:status:asset:foreignRef:from:to:amount` with semicolons. That encoding is not injective. The root does not cover validators, delegations, unbondings, withdrawals, proposals, couplings, height, or `ethExecution`.

The Merkle function is section 8.5. This root is not FS1 of \(\Omega_{s}\). FS1 of \(\Omega_{s}\) is not yet a public field.

### 8.2 Omega digest

`OmegaDigest` is a single `SHA256` of the UTF-8 text `eq-omega|` concatenated with a pipe-joined body. The body sorts the ledger and the pools and the validators. It uses `num` on amounts. It omits the unbonding segment when that list is empty, then the withdrawal segment, then the execution segment. An empty tail and a missing tail can therefore share a digest with a different arrangement of later tails. `tipHash` is not in the body.

\(R_\omega\) is this digest of \(\Omega_{\mathrm{rel}}\). It is not \(P\), not the FS1 identifier of \(\Omega_{\mathrm{rel}}\), and not a digest of \(\Omega_{\mathrm{carried}}\).

### 8.3 Evidence root

\(R_e = \mathrm{SHA256}(\mathrm{canonicalEvidence}(E))\), where \(E\) is the evidence object, or the blank evidence object `sealFromSuccessor` substitutes when evidence is absent. Blank evidence is version `1`, the predecessor chain id, wasm code `ARBITRAGE_CODE`, and four empty arrays.

`canonicalEvidence` joins fixed segments with `|` and `;` and `:`, and it omits the cognition, settlement, and withdrawal segments when all three strings are empty. Empty and absent agree in this string. The lock segment `l:id:asset:foreignRef:from:to:amount` does not escape `:`. The function is not injective.

\(R_e\) commits to that string. It does not commit to the evidence object. It is not a function of the rest of \(C\).

### 8.4 Transition root

\(R_t\) is a single `SHA256` of the UTF-8 text `eq-transition|` concatenated with this pipe-joined body, taken from the predecessor and from \(I\), not from \(\Omega_{\mathrm{rel}}\):

1. `Ω_pre.tipHash`
2. `OmegaDigest(Ω_pre)`
3. the transactions as `hash:from:to:amount:fee:nonce`, joined by `;`, with ECMA-262 `String` on the numbers
4. `canonicalEvidence(E)`, or the empty string when evidence is absent
5. `String(timestamp)`
6. the nonce in decimal, after refusing a non-`u64`
7. the miner
8. `canonicalPressure(I.committedPressure).toFixed(6)`
9. `String(difficulty)`
10. `num` of the five couplings, joined by `,`

Item 8 is `canonicalPressure(I.committedPressure).toFixed(6)`. The pressure is reduced to six fractional digits and parsed back, then rendered to six fractional digits again.

\(R_t\) does not contain \(\Omega_{\mathrm{rel}}\), \(R_s\), \(R_\omega\), or \(R_e\). A formula that puts those values inside the transition root describes a commitment this program does not compute. The header binds them beside \(R_t\), not inside it.

\(R_t\) is a claim bound by the header. It is not evidence that the claim was executed.

### 8.5 Merkle root

The transaction Merkle root is `merkleRoot` of the transaction hashes in order. If there are no transactions, the seal passes a one-element list containing 64 zero hex characters, and the root of a one-element list is that element.

`merkleRoot` of an empty list is 64 zero hex characters. Of one element, it is that element. Of more, an odd level duplicates its last element, and each pair is `SHA256d` of the UTF-8 concatenation of the two hex strings. That is not a hash of the raw digest bytes.

### 8.6 Header

The seal builds \(H\) as `SHA256d` of the UTF-8 text of these fields joined by `|`:

1. predecessor `tipHash`
2. the transaction Merkle root
3. \(R_s\)
4. `String(timestamp)`
5. the nonce in decimal
6. `String(difficulty)`
7. `String(residualFp)`
8. the miner
9. `String(Ω_pre.height + 1)`
10. `canonicalPressure(pressure).toFixed(6)`
11. `String(evidence.chainId)`
12. \(R_e\)
13. \(R_\omega\), or the empty string if it were absent
14. \(R_t\)

The seal always passes 11 through 14. A header that omits chain id or evidence root uses a shorter preimage: fields 1 through 10 only. That shorter preimage is not the seal of a current successor. A verifier must not accept the short preimage for a block this relation seals.

The residual fixed point in field 7 is the number the transition returned, rendered by `String`. It is not recomputed by the seal.

## 9. Carried state

\[
S_{\mathrm{rel}} = \mathrm{SHA256}(\mathrm{FS1}(\Omega_{\mathrm{rel}})), \qquad
S_{\mathrm{carried}} = \mathrm{SHA256}(\mathrm{FS1}(\Omega_{\mathrm{carried}}))
\]

These differ whenever \(H\) differs from the parent tip hash, which is the seal's purpose. \(\Omega_{\mathrm{carried}}\) is the state the next predecessor must be. \(\Omega_{\mathrm{rel}}\) is the state whose omega digest is \(R_\omega\).

## 10. Adoption

Let the canonical parent be the state \(\Omega_{\mathrm{actual}}\) whose tip hash is \(P_{\mathrm{actual}}\). Let the candidate header be \(H_{\mathrm{adopted}}\) and the state about to be installed be \(\Omega_{\mathrm{installed}}\).

\[
\begin{aligned}
\mathrm{ValidAdoption}
&\iff \mathrm{ValidTransition}(\Omega_{\mathrm{actual}}, I, C, \Omega_{\mathrm{rel}}, R_s, R_\omega, R_e, R_t, H_{\mathrm{adopted}}) \\
&\quad\land\ \Omega_{\mathrm{installed}} = \Omega_{\mathrm{rel}}[\mathrm{tipHash} \mapsto H_{\mathrm{adopted}}]
\end{aligned}
\]

\(I\) and \(C\) are the inputs and context of that same execution. A transition that is valid for a different parent, a different input list, or a different context does not adopt.

Replay, a stationarity check, equality of any one root, and the successor skeleton are not this predicate. There is no fallback.

The program does not implement this predicate. `ADOPTION_REQUIRES_TRANSITION_PROOF` is false.

## 11. Determinism

For one triple \((\Omega_{\mathrm{pre}}, I, C)\) in the domain of section 6, the interpreter returns one refusal or one tuple \((\Omega_{\mathrm{rel}}, R_s, R_\omega, R_e, R_t, H)\).

That claim is only as sharp as \(C\). \(C\) names ECMA-262 and a wasm bytecode hash. It does not pin an engine build. Two engines that both claim ECMA-262 and disagree on a case section 6 reaches are not one relation.

Map iteration order and array order are part of the triple. Sorting a map before distribution or finality is a different triple.

## 12. Substitutions that are not this relation

| Substitute | Why it fails |
| --- | --- |
| `omegaDigest` for \(B_{\mathrm{pre}}\) | Different function. It sorts, collapses `-0`, and drops empty tails |
| Version-1 `inputId` for the identity of \(I\) | It hashes `wasmAfter`, which the relation ignores, and it hashes a non-injective evidence string |
| A transition root that includes \(\Omega_{\mathrm{rel}}\) or the other roots | The program's \(R_t\) does not |
| \(R_s\) as a commitment to \(\Omega_{\mathrm{rel}}\) | Taken earlier, and not injective |
| \(R_\omega\) as a commitment to \(\Omega_{\mathrm{carried}}\) | Taken before `tipHash` becomes \(H\) |
| \(R_e\) as a commitment to the evidence object | It commits to a lossy string |
| Calling `successor` and then `applySuccessor` | Executes the transition twice |
| The queued evidence, when `composeBlock` retried | The block contains the second input |
| A supplied wasm map | Refused. Only execution under `ARBITRAGE_CODE` is \(D\) |
| Stationarity, the skeleton, or replay | None is section 6 |

## 13. What is still not specified as bytes

[CTP-1 Bodies](ctp-1-bodies.md) is the control flow for stake, effects, the residual, and the wasm host. [CTP-1 Rest](ctp-1-rest.md) is the control flow for selection, bitcoin, ethereum, settlement, withdrawals, model binding, and difficulty. [CTP-1 Named](ctp-1-named.md) is `verifyTx`, the Ethereum committee checks, `parseBtcTx`, `proveEthEffect`, and the wasm methods the transition actually calls. What remains is the unexecuted arithmetic inside the wasm binary, which `Reference` does not run. A circuit of the named functions is still not a proof, and adoption still does not require one. C-007 remains open.
