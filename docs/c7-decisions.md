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

## Not adopted

Forward-only activation height and FS1 NaN canonicalization are not decided. `verifyTransitionProof` still rejects every proof. `ADOPTION_REQUIRES_TRANSITION_PROOF` stays false, because turning it on would reject every block.

