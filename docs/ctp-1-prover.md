# CTP-1 prover

The implementation path stays Groth16.

[difficulty_law.rs](../equilibrium/src/difficulty_law.rs) proves `adjustDifficulty` with binary64 rounding. The circuit computes the unclamped factor, clamps it to the literals 0.8 and 1.2, and selects the branch. It does not take the factor as a public input.

The real second-block statement changes difficulty from 1,000,000 to 1,200,000. The target is 15 seconds and the interval is 12, so the factor is the 1.2 clamp. The proof accepts 1,200,000 and rejects a different result. The same circuit also accepts the interior quotient 187,500, the low clamp 800,000, and `floor(1,000,001 × 1.2) = 1,200,001`.

The older integer-division circuit remains the interior quotient without rounding. It is not this law. The same law is not a second proof beside the clock. `prove_composed` puts the statement id, the height step, the timestamp delta, the difficulty law, and the liquid credit in one public statement. The interval fed to the clamp is `timestamp_after - timestamp_before`, not a separate number. The real step is statement `801861c38e8d596f…`: height 0 to 1, time 12 to 24, difficulty 1,000,000 to 1,200,000, balance 1,500,000 plus a liquid credit of 2. Changing the difficulty, the height, or the statement id makes that proof fail.

The liquid credit is still an input. The reward that produced 2 is not computed here. The genesis block uses the target interval instead of a timestamp delta, and that clock is not this statement. The residual and the header are still outside. C-007 remains open.

