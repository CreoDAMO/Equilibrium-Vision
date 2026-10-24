# CTP-1 prover

The implementation path stays Groth16.

[difficulty_law.rs](../equilibrium/src/difficulty_law.rs) proves `adjustDifficulty` with binary64 rounding. The circuit computes the unclamped factor, clamps it to the literals 0.8 and 1.2, and selects the branch. It does not take the factor as a public input.

The real second-block statement changes difficulty from 1,000,000 to 1,200,000. The target is 15 seconds and the interval is 12, so the factor is the 1.2 clamp. The proof accepts 1,200,000 and rejects a different result. The same circuit also accepts the interior quotient 187,500, the low clamp 800,000, and `floor(1,000,001 × 1.2) = 1,200,001`.

The older integer-division circuit remains the interior quotient without rounding. It is not this law. The same law is not a second proof beside the clock. `prove_composed` puts the statement id, the height step, the timestamp delta, the difficulty law, and the liquid credit in one public statement. The interval fed to the clamp is `timestamp_after - timestamp_before`, not a separate number. The real step is statement `801861c38e8d596f…`: height 0 to 1, time 12 to 24, difficulty 1,000,000 to 1,200,000, balance 1,500,000 plus a liquid credit of 2. Changing the difficulty, the height, or the statement id makes that proof fail.

The liquid credit is no longer only an added input. For this block the successor returns a reward of 26 and a liquid credit of 2. [reward_split.rs](../equilibrium/src/reward_split.rs) computes that 2 as `floor(26 × 0.1)` and the staking floors in validator order: 6, 6, 4, 4, and 2. Their sum is 22. The remaining 2 is dust and is not credited. A claimed liquid of 3, or a last share of 3, fails the proof.

The reward is no longer a public input of a separate split. [header_reward.rs](../equilibrium/src/header_reward.rs) is one Groth16 statement for this second block. It hashes the 80-byte header, rounds the first eight bytes with `Number`, checks the hash fraction is at most the difficulty threshold, squares the distance from `1/φ`, and requires those residual bits. The height is 1. The halving series is the same binary64 addition and multiplication checked against the base-reward bits, the quality floor is 26 inside the circuit, and that 26 is what the commission splits. Changing one header byte, the residual bits, the base-reward bits, or the liquid credit makes the proof fail. The old split proof, which still accepts 26 as an input, is unchanged.

The 80-byte header in that proof is not yet the header of the carried chain. `applySuccessor` hashes the predecessor's `tipHash`. The seal writes the new tip only into the carried state. The next block therefore starts from `dcace012…`, not from zeros. Its residual is `0.027899958794187343`, its reward is 2, and its liquid credit is 0. Its statement id is `9b81c17e…`, which is the hash of the statement bytes. The id used by the reward proof does not bind to that predecessor: changing the parent tip changes the preimage, and [reward-binding.ts](../site/src/protocol/reward-binding.ts) rejects the zero-parent header for the carried block. The sealed header hash is a different field from this preimage.

The statement id, the FS1 predecessor, the input id, and the context id are the version-1 encodings. They are not yet constraints inside the reward circuit. Adoption still does not require a proof. C-007 remains open.





