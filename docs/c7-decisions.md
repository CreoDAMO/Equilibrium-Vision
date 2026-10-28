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

## Production admission

The production check is the site replay of `applySuccessor`. Rust consensus is not wired as a gate. A stationarity proof stays a residual artifact. It is not this relation, and a block is not refused because that narrower proof is absent.

## Proof composition

Staged. One step is one statement. The component circuits are not bundled into an admission requirement. The accumulated proof, when it exists, bootstraps this same chain. It is not a second relation.

## Authoritative path

`adopt` is the only site function that installs canonical state. Local `commit` and peer `absorb` both call `admissionAllows` before they reach it. A block this node mines is held to the same rule as a block a peer sends. While the proof flag is false, that call allows the replay through. When the flag is true, both paths stop.

The API server is an operational mirror. It replays `applySuccessor` and keeps its own copy. It is not a second constitution and it is not the C-007 gate. Its blocks do not carry the site statement, so it is not refused from here. Workstream 3's proof gate is the site boundary: both site paths, not five independent gates, and not the API until that wire carries the statement.

Body gossip is not an evidence channel. A body that carries evidence is refused. Evidence stays on the sync path, which keeps it. A peer's identity does not admit a block.


## Missing proof

When a transition proof is required, a missing proof, an invalid proof, and a reexecution receipt all stop admission. A new block has no compatibility path. The flag stays false until a proof of the full relation exists, because turning it on now would stop the chain.

## Proof obligation

The obligation is one relation:

predecessor, ordered inputs, context → successor, carried tip, header, state root, omega root, evidence root, transition root.

Groth16 stays the system. The circuits already built for difficulty, reward, and stationarity are not this obligation. A second prover is not adopted. `verifyTransitionProof` stays fail-closed until a proof of this obligation exists. The adoption flag stays false.

## Ancestry

The root is genesis. No checkpoint authority is adopted.

Each block's predecessor is the carried state of the block before it. The first block's predecessor is the genesis state. `adopt` refuses a break in that chain. A block already in the chain is refused when the same header is offered with a different predecessor or carried state.

An accumulated proof is the bootstrap layer for a verifier that should not replay every step. It is not built. When it is built, it has to prove this same chain, not a shorter one. Groth16 remains the step system. Recursion is reserved for that bootstrap layer. It is not a second transition relation.

`importRestartSnapshot` is still a local copy of a node's own export. It is not peer adoption, and it is not closed. The flag stays off.

FS1 NaN canonicalization is not decided.




