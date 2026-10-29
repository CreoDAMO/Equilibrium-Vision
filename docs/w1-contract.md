# Workstream 1

The circuit has to prove `faithful-v1.1` and no other relation. It is not built. A proof is still refused.

The descriptor bytes for `faithful-v1` and `faithful-v1.1` are pinned. A change to those bytes fails the pin. The beacon claim is two checks: the first committee is admitted by the transition, and a later header is checked against the committee already in the state. Neither check says the committee is Ethereum's.

The statement the circuit must open, in order, is the version, the relation id, the numeric model, the predecessor, the input, the context, the state root and its identity, the omega root, the successor, the carried state, the evidence root, the transition root, the header, the residual bits, and the wasm program.

`verifyTransitionProof` stays closed until a proof of that statement exists.
