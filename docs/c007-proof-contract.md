# C-007 transition statement

Normative bytes live in `site/src/protocol/transition-proof.ts`. This note does not add a rule the code does not implement.

The statement a complete proof has to open is one package:

- FS1 of the predecessor. `omegaDigest` is not that value.
- The ordered inputs `applySuccessor` receives, including the evidence string production already uses. That string is not injective.
- The network parameters and the wasm program id.
- FS1 of the successor the relation returned, and FS1 of the carried state whose `tipHash` is the new header.
- The header commitments `sealFromSuccessor` already publishes: `stateRoot`, `omegaRoot`, `evidenceRoot`, `transitionRoot`, and `H`.

`verifyTransitionProof` rejects every proof. The adoption paths do not call it. Setting the adoption flag while that is still true would stop the chain, so the flag stays off.

C-007 is open. A specification of the statement is not a proof, and a proof that is not required at adoption is not closure.
