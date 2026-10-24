# CTP-1 Rest

The rest of `Reference`, from the interpreter. Control flow for the four earlier bodies stays in [CTP-1 Bodies](ctp-1-bodies.md) at `e05635b`. This file does not replace that one.

## Corrections to revision 0.3

Revision 0.3 is right about the four bodies, the single snapshot, the deferred coupling, the slash, the zero-output swap, and which residual pays the reward. Three points are not adopted.

The checkpoint is `e05635b`, not `8941937`. `e05635b` is the control flow, and it corrects the delegate preimage to four trailing empty fields.

The authority snapshot is taken on the clone after `openOmega`, before the stake loop. `openOmega` does not write validators, so the power map equals the predecessor's live stake. The capture point is still that later line. A model that snapshots before the clone and one that snapshots after `openOmega` agree on this map. They would not agree if a future `openOmega` wrote stake.

The upstream gate is not part of `Reference`. Claim, vote, propose, slash, and the wasm caller are not signed inside the transition. Binding a gate result as though the transition checked it would specify a different relation. A proof of `Reference` does not prove that gate. Closing that gap would be a change to the transition, and this file does not make that change.

The header residual is `floor(canonical × 10^18)` only when the canonical residual is finite and at least `0`. Otherwise it is `-1`.

## Transaction selection

`selectSuccessorTxs` reads the predecessor. Balances are the ledger balance or `0`. Nonces are the ledger nonce or `0`. Pool membership uses the predecessor pools. `openOmega` does not change either.

A transaction is eligible when its hash has not already been chosen, its amount is a positive safe integer, its fee is a safe integer at least `0`, its nonce equals the account's predecessor nonce plus the number of that account's transactions already chosen, and the running balance is at least `amount + fee` under ordinary addition. The running balance adds receipts and subtracts earlier spends. A receipt is added only when `releasesTo` is true. The transition passes `releasesTo` false when the recipient is a pool address, so a swap does not fund a later transaction in the same selection.

Among eligible transactions, the one with the highest fee is chosen. An equal fee breaks toward the smaller hash string. The search walks the input array in order, so the first of two equal `(fee, hash)` pairs is kept only because a later one does not beat a non-strict comparison. The chosen transaction is then marked used by hash.

The result is that order, truncated at `maxTxPerBlock`. A missing nonce is not skipped by paying a higher fee. Two inputs with the same hash cannot both be chosen.

The transition calls this twice. Before effects, it refuses only when the selected list has the same length as the input and is not the same objects in the same positions. A shorter selection is not refused there. Effects then run on the clone. After effects, it refuses unless the selected list is the same length and the same objects in the same positions. The predecessor is a different object from the clone, so a refusal discards the effects. A successful transition is one whose input list is exactly the list this function returns.

## Bitcoin admission

After stake, each bitcoin evidence item, in order:

The header hex, trimmed and without a leading `0x`, must be 160 hex characters. Otherwise refuse. Proof of work must pass: SHA-256 twice over the 80 raw bytes, reversed, is less than or equal to the compact target, compared as 32-byte big-endian. The compact target's exponent is the high byte. The mantissa is the low three bytes, placed so the mantissa's first byte sits at index `32 − exponent`. An exponent outside `1..32` is a zero target.

The stored header hash is the hex of SHA-256 twice over the raw bytes, not reversed. `prevHash` is hex of bytes `4..36`. `merkleRoot` is hex of bytes `36..68`. `bits` is the little-endian uint32 at offset 72. If a tip exists, the evidence height must be `tip.height + 1` and `prevHash` must equal the stored tip hash. The first header has no tip check and no required height. A duplicate stored hash refuses. Push the record. If the list is longer than 2016, drop the oldest.

Nothing in this step mints EQU.

## Ethereum admission

After bitcoin, each ethereum evidence item, in order. The minimum participation count is 342.

A bootstrap refuses if a committee is already installed. A rotation refuses if no committee is installed, if the committee aggregate does not equal `ethPubkey`, if the participation bitset is malformed, if its popcount is below 342, or if `verifyRotation` rejects the 96-byte signature over the current committee, the bitset, and the next committee. Both bootstrap and rotation then install: the committee bytes must parse, the claimed aggregate must equal the aggregate derived from those bytes, `ethCommittee` becomes the hex of the raw keys, and `ethPubkey` becomes that aggregate.

A header refuses under the same committee, binding, bitset, and popcount checks. If a tip exists, the slot must be `tip.slot + 1` and `parentRoot` must equal the stored tip hash. The signature must pass `verifySelectedHeader`. The stored hash is `hashEthHeader` of the slot, proposer index, parent root, state root, body root, and participation bits. Push that record. Participants is the popcount, not a field of the evidence.

`verifyRotation`, `verifySelectedHeader`, `committeeRaw`, `committeeAggregate`, and `hashEthHeader` are still the functions in `eth-light.ts`. Their byte layouts are not transcribed here.

## Settlement

After ethereum, each settlement item, in order. No signature is checked.

A lock refuses unless the amount is a positive safe integer, the id is a safe integer at least `0`, the id is new, the asset is `btc` or `eth`, and some stored bitcoin or ethereum header hash equals `foreignRef`. Debit `from`. Append `{ id, asset, foreignRef, from, to, amount, status: locked }`. `from` and `to` are not checked as addresses.

A release finds the row by id. It refuses unless that row is `locked` and its foreign hash is still stored. Credit `to` with the stored amount. Set status `settled`. The release item's other fields are not read.

## Withdrawals

After settlement, each withdrawal item, in order.

An open verifies a signature before any debit. The sender, public key, and signature must be 40, 64, and 128 hex characters. The amount must be a positive safe integer. The nonce must be a safe integer at least `0`. The network must be `btc` or `eth`. The asset length is `1..40` and the destination length is `1..80`. The signature is Ed25519 over

`eq-authority|v1|chainId|withdraw|sender|amount|network|asset|destination|nonce`

and the key must derive the sender. An ethereum open then requires destination `eth:` plus 40 hex characters, and asset `eth` or 40 hex characters. A bitcoin open requires asset `btc` and a destination `p2pkh:` or `p2wpkh:` plus 40 hex characters, or `p2wsh:` or `p2tr:` plus 64 hex characters. The id is SHA-256 of

`eq-withdrawal|v1|chainId|sender|amount|network|asset|destination|nonce`

A duplicate id refuses. Expiry is `Ω.height + withdrawalTimeout`, using the predecessor height, and it must be a safe integer. Debit the sender. Credit the same amount to the escrow account, whose address is the first 40 hex characters of SHA-256 of `eq-withdrawal-escrow|v1`. Append the locked row with `effectLocator` null and `createdHeight` the predecessor height.

An `exec` item only admits an execution header. The RLP must be even hex and parse. A duplicate hash refuses. If a tip exists, the parent hash must equal it and the number must be one higher. Push. If the list is longer than 256, drop the oldest. This writes `ethExecution` and does not move EQU.

`settleEth` requires a locked row, `Ω.height + 1 < expiryHeight`, network `eth`, and an eth asset. The named execution header must be stored. `proveEthEffect` must succeed, and its destination, amount, and asset must equal the row. A locator already used on any withdrawal refuses. Debit the escrow. Set status `settled` and store the locator. The sender is not credited.

A bitcoin settle uses the same lock and expiry checks. An ethereum row on this path refuses with `eth execution proof refused`. The row must be network `btc` and asset `btc`. The raw transaction must parse, the header hash must be 64 hex characters and be stored, and `proveBtcOutput` must show that `vout` is in the Merkle tree of that header and that the output's destination and amount equal the row. The locator is `txid:vout`. The same escrow debit and settle follow. The sender is not credited. The value has left the ledger.

Matured refunds are a later body, already named: a locked row whose `expiryHeight` is at most the next height debits the escrow and credits the sender, then sets `refunded`.

## Model binding

After effects and the second selection check, each cognition item, in order. A `bind` item is skipped here.

A challenge refuses if the model is missing or already `slashed`, if the support hash is not 64 hex characters, or if that hash equals the stored support hash. The proof must equal SHA-256 of `eq-challenge|chainId|id|supportHash`. The status becomes `slashed`. No balance moves.

Any other item refuses if the uri is empty or longer than 128, the residual is not a safe integer at least `0`, or the support hash is not 64 hex characters. The proof must equal SHA-256 of `eq-model|chainId|id|uri|residualFp|supportHash`. A new id is inserted at the front as `bound`, with `proposedAt` the block timestamp. An existing id refuses unless both the support hash and the residual equal the stored row. A matching existing row is not rewritten.

After the state root is taken, each `bind` item must carry that same residual fixed point, and its proof must equal SHA-256 of `eq-bind|residualFp|stateRoot`. This check does not write `Ω`. A challenge or a registration is not re-checked here.

## Difficulty

After the monetary and identity checks, write the next height and the timestamp. The interval is `targetBlockTimeMs / 1000` when the predecessor height is below `0`. Otherwise it is `timestamp − tipTimestamp`. If the interval is not positive, the difficulty is unchanged.

Otherwise let each present tip contribute. The tip byte is the last two hex characters of the bitcoin tip hash, then of the ethereum tip hash, parsed as an integer. No tip contributes nothing. A tip contributes `round((byte / 255) × 100)`. Start from `1/1` and, for each contribution `bump`, multiply the numerator by `9950 + bump` and the denominator by `10000`.

The unclamped factor is `(target / interval) × (numerator / denominator)`. Clamp it to `[0.8, 1.2]`. If the clamped value is exactly `0.8` or exactly `1.2`, the next difficulty is `max(100000, floor(difficulty × factor))`. Otherwise it is `max(100000, floor((difficulty × target × numerator) / (interval × denominator)))`.

## Distribution

After the state root and the binding check, add one to the miner's `blocksProposed`. Then distribute the staked remainder. If that remainder is not a safe integer at least `0`, refuse. If it is `0`, do nothing. Otherwise walk validator values in insertion order and keep those that are not jailed, not slashed, and have a positive safe bonded stake. Sum that stake with `safeAdd`. Refuse on overflow or on a total that is not positive. For each survivor, in that same order, `staked × bondedStake` must be a safe integer. The share is `floor` of that product divided by the total. Add it to `accumulatedRewards`. A share that does not fit refuses. Dust below one unit per validator is not paid and is not assigned to anyone else.

## What remains a name

`verifyRotation`, `verifySelectedHeader`, `hashEthHeader`, `parseBtcTx`, `proveEthEffect`, and the instructions inside `ARBITRAGE_WASM` are not transcribed. The arbitrage source directory in this checkout has no Rust or WAT file. The host boundary is specified. Inventing the contract's instructions would not specify them. C-007 remains open.
