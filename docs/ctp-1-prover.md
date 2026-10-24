# CTP-1 prover

The implementation path stays Groth16, in [ctp1_circuit.rs](../equilibrium/src/ctp1_circuit.rs).

Plonky3 and RISC Zero are not the next prover. Re-proving height, time, and the liquid credit in a second system would not compute the residual, the header, or the wasm host. RISC Zero is already an optional dependency for a later guest. It is not a second transition. A guest that is not the ECMA-262 successor would be a different relation.

The real second-block statement `801861c38e8d596f…` changes difficulty from 1,000,000 to 1,200,000. The target is 15 seconds and the interval is 12, so the unclamped factor is 1.25 and production takes the `1.2` clamp: `floor(difficulty × 1.2)`. That multiply is binary64. The integer division branch is a different formula, and this circuit refuses the clamp.

C-007 remains open. The next computation that has to enter a circuit is that clamp, or the residual digest. Not another proof system.
