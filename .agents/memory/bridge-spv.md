---
name: Bridge SPV implementation
description: SHA-256 Merkle inclusion proof for CrossChainRelay inbound attestations (methods 11+12)
---

## Rule
Method 11 (`submit_header`) stores a foreign block's SHA-256 binary Merkle root.
Method 12 (`submit_inbound_spv`) verifies inclusion before accepting attestation.

**Leaf hash definition:** `sha256(commitmentHex as UTF-8 bytes)` — both Rust and TS must agree on this.
- Rust: `sha256_bytes(commitment_hex.as_bytes())`  
- TS test: `createHash("sha256").update(commitmentHex, "utf8").digest()`

**Why:**  Allows relayers to cryptographically prove a commitment was in a submitted block rather than relying on pure m-of-n trust.

## How to apply
- Storage key: `"hdr:{chainId}:{blockNum}"` → lowercase hex root (64 chars)
- SPV flag stored: `set_att_field(chain_id, seq, "spv", "1")`
- Sibling ordering: bottom-up (leaf sibling first)
- Rust reads siblings as raw bytes from args memory (not words)
- TS args layout for method 12 SPV section: blockLo, blockHi, proof_depth, leafLo, leafHi, [sib[0] 8 words], ...

## Known pitfall
In tests, the Merkle tree filler and root must be shared across test cases — do NOT
regenerate `randomBytes()` in each individual test. Use `beforeAll` + shared variables.
A shared `Buffer.alloc(32, 0x42)` filler is deterministic and safe.

## Error codes (method 12)
- -10: No header stored for that chainId+blockNum
- -11: Merkle inclusion proof invalid (computed root ≠ stored root)
