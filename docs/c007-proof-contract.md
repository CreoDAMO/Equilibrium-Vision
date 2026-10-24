# C-007 transition statement

The formal specification is [CTP-1](ctp-1.md). This note is only the pointer.

Version-1 statement bytes live in `site/src/protocol/transition-proof.ts`. They are a partial encoding of CTP-1 section 4, not the specification, and not a proof.

`verifyTransitionProof` rejects every proof. The adoption paths do not call it. C-007 is open.
