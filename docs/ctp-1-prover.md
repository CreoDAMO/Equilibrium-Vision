# CTP-1 prover

The implementation path stays Groth16.

[difficulty_law.rs](../equilibrium/src/difficulty_law.rs) proves `adjustDifficulty` with binary64 rounding. The circuit computes the unclamped factor, clamps it to the literals 0.8 and 1.2, and selects the branch. It does not take the factor as a public input.

The real second-block statement changes difficulty from 1,000,000 to 1,200,000. The target is 15 seconds and the interval is 12, so the factor is the 1.2 clamp. The proof accepts 1,200,000 and rejects a different result. The same circuit also accepts the interior quotient 187,500, the low clamp 800,000, and `floor(1,000,001 × 1.2) = 1,200,001`.

The older integer-division circuit remains the interior quotient without rounding. It is not this law. The same law is not a second proof beside the clock. `prove_composed` puts the statement id, the height step, the timestamp delta, the difficulty law, and the liquid credit in one public statement. The interval fed to the clamp is `timestamp_after - timestamp_before`, not a separate number. The real step is statement `801861c38e8d596f…`: height 0 to 1, time 12 to 24, difficulty 1,000,000 to 1,200,000, balance 1,500,000 plus a liquid credit of 2. Changing the difficulty, the height, or the statement id makes that proof fail.

The liquid credit is no longer only an added input. For this block the successor returns a reward of 26 and a liquid credit of 2. [reward_split.rs](../equilibrium/src/reward_split.rs) computes that 2 as `floor(26 × 0.1)` and the staking floors in validator order: 6, 6, 4, 4, and 2. Their sum is 22. The remaining 2 is dust and is not credited. A claimed liquid of 3, or a last share of 3, fails the proof.

The 26 is no longer only a checked formula. For this block the header is 80 bytes: a zero parent hash, a zero merkle root, timestamp 24, and nonce 1. Its SHA-256 begins with the little-endian integer `10396461113802754501`. The binary64 residual of that integer is `0.0029637900846207032`, the halving series at height 1 floors with the quality multiplier to 26, and the split turns 26 into the liquid credit of 2. That chain is an executable check in `binary64.rs`. It is not yet a Groth16 constraint. `Math.pow` is matched here by the same series JavaScript evaluates for this exponent, not by a rational substitute.

The reward argument of the split circuit is still a public input. C-007 remains open.



