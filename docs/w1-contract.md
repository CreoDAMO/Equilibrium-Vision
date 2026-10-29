# Workstream 1

`faithful_v1` is a Groth16 circuit. It proves the next height, a timestamp that does not move backwards, the liquid credit, and a residual strictly under the threshold. It accepts only the pinned `faithful-v1.1` identifier. Predecessor, carried state, and header are bound into the proof and are not computed from a predecessor.

It is not a proof of `applySuccessor`. `verifyTransitionProof` still rejects every proof. The adoption flag stays off.
