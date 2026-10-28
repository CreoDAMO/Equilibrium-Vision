# C-007 decisions adopted at the executor

Source: `fbcc0d0`, then this change. C-007 stays open. The adoption flag stays false.

## Swap timestamp — Decision B

`SwapEvent.timestamp` is the transaction timestamp copied by `applyEffects`. It is not in `signingBytes`, not in the transaction hash, and not in the header.

The protocol does not promise that this timestamp is an authenticated historical fact. It is an auxiliary observation. A verifier may check that the statement's input contains the same timestamp the block carried. That check does not authenticate who chose the timestamp or when.

Options A and C would require a signature or a separate authentication mechanism. Neither exists. Promising them would be a claim the transition does not enforce.

## Transaction projection — Decision 1

`executionInputId` includes `hash`, `from`, `to`, `amount`, `fee`, `nonce`, `timestamp`, `signature`, and `publicKey`.

It excludes `status`, `blockHash`, and `blockHeight`. Those three are written when a block is sealed. Including them made the same transaction a different input on the way in and on the way back through `commit`.

The projection is the statement's `inputId`. `encodeInputs` still exists and still collapses an absent evidence list into an empty one. That string is not the statement.

## Host ABI — Decision C, storage bound, position 2

Caller identity is 40 lowercase hex characters. The host checks that before the call and writes those 40 bytes. It does not slice UTF-16. A caller that is not that form is refused, and the module is not entered. The current module's 64-byte caller buffer holds those 40 bytes.

Storage keys and values are at most 256 UTF-8 bytes. Decoding is fatal: a byte sequence that is not UTF-8 is not stored. A refused write is discarded with the rest of that call. The module cannot negotiate capacity. 256 is the buffer the host will write, and it is the maximum the contract allows into Ω.wasm. A restored map that breaks the bound is refused rather than served.

`contextId` commits to `hostAbiManifest()`, not only to a version label.

Versioning is position 2. The host ABI is its own identity, and it is coupled to the block context. Evidence does not carry a second ABI stamp. A call executes under the context of the block that includes it. One version exists. A later ABI change changes `contextId`, so a statement from this version does not name that context.

This does not close C7-C. The host contract is not a proof.

## Numeric domain — §2.5-a

The admitted domain is the one `applySuccessor` already refuses outside of:

- Nonce: integer in `[0, 2^64 - 1]`.
- Timestamp: safe integer, `>= 0`, and not behind the previous tip once height is non-negative.
- Pressure: finite and inside `[0, 1]`.
- Amounts, fees, balances, stake: safe integers. Amounts that move value are positive. Fees are non-negative.
- Difficulty: the input must equal the predecessor's difficulty. `adjustDifficulty` does not return a value below `100_000`. That floor is not a new admission check.

`bounds.ts` is that domain. A proof of the transition has to use these bounds. A tighter domain would be a different relation.

## Predecessor packaging

The predecessor is `fullStateId` of the omega installed on the node. It is not a header field. Putting it in the header would change the hash the residual is computed from. `adopt` compares the statement's predecessor to the installed state before it installs the successor. A statement about a different predecessor is refused.

## Proof obligation

The obligation is one relation:

predecessor, ordered inputs, context → successor, carried tip, header, state root, omega root, evidence root, transition root.

Groth16 stays the system. The circuits already built for difficulty, reward, and stationarity are not this obligation. A second prover is not adopted. `verifyTransitionProof` stays fail-closed until a proof of this obligation exists. The adoption flag stays false.

## Not adopted

FS1 NaN canonicalization is not decided.


