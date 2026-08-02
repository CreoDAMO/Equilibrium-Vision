---
name: CrossChainRelay BLS upgrade
description: Replacing per-signer Ed25519 with BLS12-381 aggregate signatures in the inbound attestation path — signing pattern, ABI word layout, and @noble/curves v2.2.0 API gotchas.
---

## The rule

`method_submit_inbound` (method 3) accepts ONE BLS12-381 G2 aggregate signature over all signers, not per-signer Ed25519 signatures. The ABI word layout at the args_ptr is:

```
0              chain_id_len
1..cw          chain_id bytes  (cw = ceil(chain_id_len/4))
off = 1+cw
off+0..1       seq_lo, seq_hi
off+2..9       commitment (8 words = 32 bytes)
off+10         n_signers
off+11..34     agg_sig (24 words = 96 bytes, BLS G2 compressed)
off+35 + i*22  signer i: pubkey (12 words = 48 bytes G1 compressed)
               + addr   (10 words = 40 bytes hex)
```

**Why BLS over Ed25519:**
- Smaller calldata: 22 words/signer + 24 words shared vs 34 words/signer
- Stronger security (pairing-based); fits naturally into the host's `bls_aggregate_pubkeys` / `bls_verify` imports

## @noble/curves v2.2.0 API — critical gotchas

`bls12_381.longSignatures` mode (G1 pubkeys, G2 sigs):

```ts
const BLS = bls12_381.longSignatures;
const G2  = bls12_381.G2;

// getPublicKey() returns a Point object — call .toBytes(true) for 48-byte G1 compressed
const pubKeyBytes = BLS.getPublicKey(privKey).toBytes(true);  // 48 bytes

// sign() requires the message to be ALREADY hashed to a G2 point — passing raw bytes throws
// "expected valid message hashed to G2 curve"
const msgPoint = G2.hashToCurve(new TextEncoder().encode(msg));
const sigBytes = BLS.sign(msgPoint, privKey).toBytes(true);   // 96 bytes

// aggregate
const aggSig = BLS.aggregateSignatures([sig1, sig2]).toBytes(true);  // 96 bytes
const aggPub = BLS.aggregatePublicKeys([pub1, pub2]).toBytes(true);  // 48 bytes

// verify (msgPoint must be the same hashToCurve call, not raw bytes)
const ok = BLS.verify(aggSig, msgPoint, aggPub);  // boolean
```

The `wasm.ts` `bls_verify` host does `G2.hashToCurve(msg)` internally, so the Rust contract just passes raw message bytes — but test-side signing MUST hash first.

**How to apply:**
- Any test or client building attestation requests must use `buildAggPayload(signers, msg)` pattern (hash → sign each → aggregate → submit `aggSigHex + signers[]`)
- Address derivation unchanged: `sha256(pubKeyBytes_48).digest("hex").slice(0, 40)`
- pubkeyHex = 96 hex chars (48 bytes G1 compressed); aggSigHex = 192 hex chars (96 bytes G2 compressed)
