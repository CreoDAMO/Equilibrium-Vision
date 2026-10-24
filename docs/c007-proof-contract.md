# C-007

The relation is [CTP-1 Relation](ctp-1-relation.md). The proof obligation for that relation is [CTP-1](ctp-1.md).

Version-1 statement bytes in `site/src/protocol/transition-proof.ts` are not the relation. They hash `wasmAfter`, which `applySuccessor` does not read, and they hash an evidence string that is not injective. `verifyTransitionProof` rejects every proof. Adoption does not call it.

C-007 is open.
