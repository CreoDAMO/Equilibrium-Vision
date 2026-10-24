# CTP-1 prover

The implementation path stays Groth16.

[difficulty_law.rs](../equilibrium/src/difficulty_law.rs) proves `adjustDifficulty` with binary64 rounding. The circuit computes the unclamped factor, clamps it to the literals 0.8 and 1.2, and selects the branch. It does not take the factor as a public input.

The real second-block statement changes difficulty from 1,000,000 to 1,200,000. The target is 15 seconds and the interval is 12, so the factor is the 1.2 clamp. The proof accepts 1,200,000 and rejects a different result. The same circuit also accepts the interior quotient 187,500, the low clamp 800,000, and `floor(1,000,001 × 1.2) = 1,200,001`.

The older integer-division circuit remains the interior quotient without rounding. It is not this law. The header, the residual, the evidence, and the wasm host are still outside. Verification of this proof does not run `successor`. C-007 remains open.
