# CTP-1 Named

The functions [CTP-1 Rest](ctp-1-rest.md) left unnamed, from the interpreter. This file does not change the four bodies or the admission order.

## verifyTx

`signingBytes` is the concatenation of:

- the sender as raw hex bytes,
- the recipient as raw hex bytes,
- the amount as an unsigned 64-bit little-endian integer,
- the fee the same way,
- the nonce the same way,
- the public key as raw hex bytes,
- the chain id the same way.

The unsigned 64-bit conversion masks with `2^64 − 1`. A value `BigInt` cannot encode throws. `verifyTx` catches that and returns false.

Verification decodes the signature and the public key as hex. Ed25519, with SHA-512 as the hash, must accept the signature over those bytes. The transaction hash must equal SHA-256 of the signing bytes concatenated with the raw signature. The first 40 hex characters of SHA-256 of the 32-byte public key must equal the sender. The timestamp, the status, the block hash, and the block height are not in the preimage. Any throw is a refusal.

## Ethereum committee

A participation string is 128 hex characters, optionally prefixed by `0x`. It is 64 bytes. Anything else throws, and the caller treats that throw as a refusal. The popcount is the number of set bits.

A committee is exactly 512 compressed keys, 48 bytes each, 24576 bytes, 49152 hex characters. `committeeRaw` returns null otherwise. `committeeAggregate` splits those bytes into 512 keys and returns the hex of their BLS aggregate, or null if the aggregate throws. `subsetAggregate` keeps key `i` when bit `i` of the 64-byte bitset is set, bit `i` being bit `i & 7` of byte `i >> 3`. An empty selection throws.

`hashEthHeader` refuses unless the participation is 64 bytes. The digest is SHA-256 of the concatenation of the UTF-8 text `equilibrium-eth-lc-v1`, the slot as an unsigned 64-bit little-endian integer, the proposer index the same way, the parent root, the state root, and the body root as raw hex bytes, then the 64 participation bytes. A slot or proposer that is not a non-negative safe integer throws.

`verifySelectedHeader` parses the committee, aggregates the selected keys, and asks `verifyEthHeader`. Any throw is false. `verifyEthHeader` hashes that digest with the BLS hash-to-curve of `@noble/curves/bls12-381.js` `longSignatures`, then verifies the signature under that public key. The signature used by admission is 96 bytes. A failed verify is false.

`verifyRotation` is the same subset aggregate over the current committee. The signed payload is SHA-256 of the UTF-8 text `equilibrium-eth-rotate-v1` concatenated with the raw bytes of the next committee. The same BLS verify decides it. Any throw is false.

This is that library's long-signature suite. A different BLS encoding is not this function.

## parseBtcTx

The input must be at least 10 bytes. The first four bytes are the version. If the next two bytes are `00 01`, the transaction is segwit and parsing continues after them. Otherwise it continues at byte 4.

A compact size is the next byte when it is below `0xfd`, the next two bytes little-endian when it is `0xfd`, or the next four bytes little-endian when it is `0xfe`. `0xff` is a refusal. More than 10000 inputs, outputs, or witness items is a refusal.

Each input is 32 bytes, then 4 bytes, then a compact script, then 4 bytes. Each output is an 8-byte little-endian value and a compact script. A value that is not a safe integer is stored as null. The script destinations are:

- 25 bytes beginning `76 a9 14` and ending `88 ac`: `p2pkh:` plus the 20-byte hash
- 22 bytes beginning `00 14`: `p2wpkh:` plus the 20-byte hash
- 34 bytes beginning `00 20`: `p2wsh:` plus the 32-byte hash
- 34 bytes beginning `51 20`: `p2tr:` plus the 32-byte hash

Any other script has a null destination. After the outputs, a segwit transaction reads one witness stack per input and then four locktime bytes. The total length must be consumed exactly. The txid is the hex of SHA-256 twice over the non-witness serialization: version, inputs, outputs, and locktime, with the segwit marker removed. It is not the display-reversed txid.

`proveBtcOutput` refuses a `vout` that is not a safe integer inside the output list, a null value, a null destination, or a txid or root that is not 64 hex characters. Each Merkle sibling must be 64 hex characters. The proof starts at the txid bytes and, for each sibling, replaces the current hash with SHA-256 twice over the current bytes followed by the sibling bytes. There is no left/right bit. The final hash must equal the root. The locator is `txid:vout`.

## proveEthEffect

Keccak-256 is the hash. RLP is the byte encoding this file's interpreter uses: a short string, a long string, a short list, or a long list, with the usual non-minimal and leading-zero rejections on the long forms. An integer is the shortest big-endian bytes, and zero is an empty string. A decoded integer refuses a leading zero byte, or a width above six bytes, or a value that is not a safe integer.

An execution header is an RLP list of at least 15 items whose re-encoding equals the original bytes. Item 0, item 4, and item 5 are 32 bytes: parent hash, transactions root, receipts root. Item 8 is the block number. The stored hash is the hex of keccak-256 of the original bytes.

A receipt trie key is the RLP integer of `txIndex`, which must be a safe integer at least `0`. Both roots must be 64 hex characters. `verifySecureTrie` walks the proof from that root. The path is the nibbles of keccak-256 of the key. A node matches the expected hash when the expected value is 32 bytes and is keccak-256 of the node, or when the expected value is shorter than 32 bytes and equal to the node. A 17-item node is a branch. An empty remaining path returns item 16. Otherwise the walk takes the child at the next nibble. A 2-item node is a leaf or an extension, using hex-prefix. A leaf must consume the remaining nibbles and be the last proof node. An extension must be a prefix of the remaining nibbles. Any other shape fails. The proved bytes must equal the supplied receipt.

The receipt may begin with a type byte `1..4`, which is skipped. The body is an RLP list of at least four items. Item 0 is a status of `0` or `1`. Item 3 is the log list. Each log is an address of 20 bytes, a list of 32-byte topics, and a data string. A receipt whose status is not `1` refuses.

If the asset is `eth`, the same trie check is repeated under the transactions root for the supplied transaction and its proof. The transaction may be legacy, type `1`, or type `2`. The recipient is item 3, 4, or 5 of that list, and it must be 20 bytes. The value is the next item and must be a safe integer. Contract creation, an empty recipient, is a refusal. The effect destination is `eth:` plus that address. The amount is the value. The locator is `blockHash:txIndex:value`.

Any other asset must be 40 hex characters. `logIndex` must name a log. That log's address must equal the asset, it must have three topics, and the first topic must be

`ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`

The third topic must begin with 24 zero hex characters. The data must be 32 bytes whose integer is a safe integer. The destination is `eth:` plus the last 20 bytes of that topic. The locator is `blockHash:txIndex:logIndex`.

## The wasm program

The source directory `contracts/arbitrage` is empty. The program is the bytes whose SHA-256 is `ARBITRAGE_CODE`. What follows is the behavior of those bytes under the host in [CTP-1 Bodies](ctp-1-bodies.md), not a transcription of every instruction. Methods other than the three `executeWasm` calls are not part of `Reference`.

`alloc` returns a zeroed region in the probed binary. `init`, method `0`, reads 40 bytes at the argument pointer and ignores the length the host passed. If `owner` is already stored, it returns `-1` and writes nothing. Otherwise it stores those 40 bytes as `owner`, stores `paused` as `0`, logs `ArbitrageInitialized`, and returns `1`. It does not read `caller_address`. `executeWasm` passes the evidence caller as those bytes. A caller of 40 characters becomes the owner. A shorter caller leaves the unread tail as the allocator returned it, which this binary returned as zeros.

`pause`, method `2`, returns `-1` when `owner` is absent or when the 40 characters written by `caller_address` are not that owner. Otherwise it stores `paused` as `1`, even if it was already `1`, logs `ArbitragePaused`, and returns `1`.

`unpause`, method `3`, uses the same owner check. On success it stores `paused` as `0` and `circuit_tripped` as `0`, logs `ArbitrageUnpaused`, and returns `1`. It does this even when the contract was not paused.

Method `1` is not called by `executeWasm`. On the probed binary it returns `-1` unless the caller is the owner. On success it stores a 40-byte `registry` and a decimal `model_id` taken from the next four bytes as a little-endian integer.

Method `4` is not called by `executeWasm`. On the probed binary it calls `call_contract` and returns `-3` when that import returns `-1`. Methods `5` and above return `-99`.

The binary also contains the names `arbitrageMaxTradeAmount`, `arbitrageWindowBlocks`, `window_start`, and `exec_count`. None of methods `0`, `2`, or `3` write them. Their arithmetic is not specified, because `Reference` does not execute it. `dex_multi_swap` is not called by those three methods.

## Still not a proof

These functions are now specified as the interpreter computes them. `verifyTransitionProof` still rejects every proof. Adoption still does not call it. C-007 remains open.
