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

## Not adopted

Forward-only activation height, FS1 NaN canonicalization, and a proof at `adopt` are not decided here. `verifyTransitionProof` still rejects every proof.
