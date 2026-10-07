# Equilibrium

Proof-of-Stationarity. One public kernel in `site/`, and the older TypeScript node in `artifacts/api-server/`. They are not the same body.

## Current state (26 September 2026)

Not production-ready. A second body, given only the blocks, produced the next block and a third body accepted it. A Postgres process was killed and a new one loaded the same state and the same next block. That is two measurements. It is not a network, and it is not a coin anyone should rely on.

The questions that were being mixed together are separate. The transition question is what `successor` does with the inputs it is given. The production question is whether a second party can hold EQU, and whether a verified Bitcoin or Ethereum header changes anything after it is stored. Leaving EQU onto another chain is not one of those questions. The bridges are there to admit foreign headers, not to export the coin.

### Public kernel

Measured on a fork of `site/`, not asserted:

- A block was produced and the residual was recomputed.
- The ledger grew by the liquid coinbase. At the measured residual that coinbase was 99 EQU, of which 9 was spendable and 90 was staked.
- 1,000 EQU moved from one key to another inside this kernel.
- A swap moved the EQU-USDC pool reserve by 10,000. The genesis liquidity allocation did not move by that amount. The pool is not that purse.
- An unfunded transfer of 10,000,000,001 was refused by the mempool and by `successor`. The sender was unchanged. No recipient balance was created.
- Nothing in the transition pays an exchange, a bank, or another chain.

The browser wallet at `/wallet` creates an Ed25519 key that stays in the browser. That is a second party holding a key, against this kernel. It is not custody outside the kernel, and it is not a second producer. Testnet has a faucet. Mainnet does not.

### The transition's domain

`successor` is defined on the inputs it is given, and it refuses an input the sender cannot cover. That check is inside the transition. A port that copies `successor` and skips the producer's selection loop still cannot mint a recipient balance. EQ-03 and EQ-06 state this. It is no longer an upstream promise.

What still has to be supplied, because the transition does not derive it: the miner, the timestamp, and the committed pressure. Two admitting nonces can share one state while the reward is clipped, and still be two different blocks. Zeroing λ_structural changed the residual and not the state, under that same clip.

The wasm host is named. It is `callArbitrage` over the arbitrage module whose sha256 is the evidence code. Any other code is refused. Two storage maps are still two states, because that map is the host's output and it is part of Ω. Stratum does not call the variational-ai CLI. Admission is the canonical residual recomputed in this process.

A verified Bitcoin tip changes the next difficulty. Each foreign tip's last byte maps into a factor in [0.995, 1.005]. That factor multiplies the time rule, and the product is still clamped to 0.8 and 1.2. No tip leaves the time rule unchanged. The header is not only a leaf in the state root. EQ-20 states this. It does not move a balance by itself, and it does not pay another chain.

### Money, as declared

The paid rule is `floor(100 × (1/2)^(height / 2,100,000) × min(1, target / (R + 1e-9)))`. The old `50,000,000 × min(1/(R + 1e-6), 1)` line is not the rule. EQ-17 now says so, and the kernel pays the declared number.

`genesis.json` has an `initial_supply` header of 100,000,000. Its seven allocation lines sum to 95,000,000. The kernel credits the lines, not the header. It then credits operating balances. On testnet those are a 25,000,000 treasury, a 2,000,000 producer of which 500,000 is bonded, three activity keys at 1,500,000 each, and 5,000,000 of genesis validator stake held as liquid. The initial testnet ledger is 131,000,000. Mainnet uses an 8,000,000 treasury, and its initial ledger is 114,000,000. The gap between 95,000,000 and 131,000,000 is that wider scope. It is not an unexplained mint.

When the producer is bonded, liquid issuance is `floor(reward × 0.1)` and the rest is staked. A double-sign slash burns 5% of bonded stake. Downtime burns 1%. Difficulty is clamped to a factor between 0.8 and 1.2 and does not fall below 100,000.

### Production tree

`artifacts/api-server` is the older node. It is not the public kernel. The chain unit file is the check that was run against it.

Coinbase is credited on the account ledger only. It is not also created as a UTXO. A transfer the account ledger rejects is marked failed and creates no output. A transfer it accepts does not mint a second recipient UTXO. Broadcast rejects a transaction the ledger cannot apply before it enters the mempool. The stratum miner now uses that same selection. A UTXO-model fee is credited on that same ledger. It is not a second output. A block with 1,500 pending fees left the miner's UTXO balance at 0, recorded `utxoFeeCredit` 1,500, and added 1,500 to the coinbase on the ledger. Rollback of a block that had swept 750 restored the pool to 750 and the miner ledger to 0. The fee breakdown reads the live credit plus any leftover `utxo-fees-${height}` output. A restart reloads the balance and does not rebuild that line. The chain unit file passed 70 tests.

A rollback restores the account coinbase and the transfers from the snapshot taken at the start of the block, and it restores the UTXO fee pool. Blocks that were added before that snapshot existed still have nothing to restore.

A swap that cannot pay does not debit. A multi-hop swap that fails on a later hop puts the pools, the trader, and the swap history back.

The state root commits pool reserves and validator bond, jail, and slash, as well as accounts, UTXOs, and contract storage. A restart snapshot carries those partitions inside the existing ledger document, under `__partitions`. On 26 September 2026 that snapshot was written by one process, Postgres was stopped with `immediate`, and a different process on a new postmaster loaded it through `initChain`. The restored state root was `58f7201f55a814857a5fc1c152cce1b9cf436497cf1890e8453b47443b709f78`. Difficulty was 1,200,000, not the 1,000,000 the block had been mined under. The canonical residual of the same next header was `0.016924195219037475` on both sides. Applying the same unpersisted next block produced state root `519816753b910f652575f9b50c1a08d7e6978bb2b14e4a7384e324db8bd0e188` and difficulty 1,440,000 on both sides. Alice stayed at 4,000, the pool reserve at 50,000, and the validator bond at 2,000.

The paid coinbase on this node is the same `canonicalCoinbase` the public kernel pays. The Rust testnet node calls the same curve. `compute_coinbase_reward` is still in the crate. It is not the block path. `optimize_full` still returns a best-effort territory candidate when its target is missed. It is not the search that mines. `search_canonical` walks the residual the kernel admits. For the public vector, nonce 0 is `0.02519000125198503` and nonce 6 is `0.0002011002025239986`. Rust and TypeScript both compute those numbers, and the search returns nonce 6. A block is kept only when this process recomputes the same residual and it is under the target. Callers that only looked at `ok: true` still have to read `admitted`.

External submit and stratum store the recomputed residual, not a claim this process did not check. Stratum does not spawn a CLI to decide the share. The internal RNG miner is still a test hatch. It is not the production path.

A public-kernel producer was stopped after it had admitted the Bitcoin genesis header. Its difficulty moved from 1,000,000 to 995,000, because that header's hash ends in byte 0 and the foreign factor is 0.995. A second body was given only the blocks. It produced height 10. The residual was `0.0014545903682062166`. The previous hash was `9b33cb1f8e65e414a9414288dc2dd9c0ce3ca6ae7ec5c895e5c2c3280b02c9fd`. A third body, also without the first process, accepted the block, kept the same Bitcoin tip `6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000`, and the same next difficulty, 990,025. Replaying the blocks and stopping there is still a different operation. It ends at height 9.

New blocks on the artifacts node seal with `canonicalHeaderHash` after the state root exists. The provisional `hash256(block-height-prev-time)` string is not the identity that is stored. The frozen header — previous `11`×32, merkle `22`×32, state `33`×32, time 1,700,000,000, nonce 7, difficulty 1,000,000, residual fingerprint 201,100,202,523,998, miner `ab`×20, height 3, pressure 0 — hashes to `836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306` in the kernel, in the artifacts node, and in Rust `canonical_header_hash`. Nonce 8 is a different hash. A credit changes the state root and therefore the hash. Pressure is a column. A block sealed at pressure 0.25 was written and read back; the recomputed hash was `d716fab2dd70066731203deb600b5e6c075425fc2af4c5b168123b8191075c61`, and the same header at pressure 0 was not. Rows written before the seal are not resealed. A fee credited on the ledger is undone by restoring the snapshot, not by deleting a height-keyed output. A leftover output from an older build is still removed on rollback, and its amount is not added back when the snapshot is present.

A validator miner is not paid twice. On the artifacts node, reward 100 with commission 0.1 and two equal bonds credited 10 on the ledger and 45 accumulated rewards to each validator. The delegator's balance stayed 50. Created value was 100. On the kernel, the same nonce-6 header paid reward 99: 9 liquid, 88 accumulated, 2 unminted by the floor. Nothing above the reward was created. EQ-18 says so. There is no participation pool.

`stateRootOf` does not move when only a validator's bond changes. The omega digest does. A balance change moves both. EQ-07 says that. The artifacts state root is a different commitment: it also binds UTXOs, contract storage, and validator bond. Those two roots were not forced together.

The ten-field header is not the header the kernel produces. A kernel block carries evidence, so the preimage also binds chain id, the evidence root, and the omega digest. One mainnet transition was run: two validators, bonds of 1,000, commission 0.1, nonce 6, pressure 0, block time 15 seconds, blank evidence. The reward was 99, the liquid credit was 9, and each validator's accumulated rewards were 45. Created value was 99. With no foreign tip the next difficulty stayed 1,000,000. A Bitcoin tip whose hash ends in byte 0 moved it to 995,000. The artifacts difficulty law, given that same interval and that same tip, returns those same integers, including the off-rail step at 14 seconds, 1,071,428. The evidence-bearing header was `795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2` in the kernel, in the artifacts hash function, and the ten-field preimage of the same block was a different hash. The artifacts seal appends those three fields only when the block also supplies the canonical state root. It does not put its own sparse-merkle root in that field. A block that carries evidence fields and no canonical root is sealed as the ten-field header over the operational root, and the evidence fields are dropped. A Bitcoin header is admitted only when it meets its proof-of-work target. The genesis header hash is `6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000` in both bodies, and that tip moves difficulty to 995,000. A string that is not a header does not. An Ethereum hash written on the artifacts node does not move difficulty unless `admitEthHeader` accepted it. A raw `ethTipHash` is not admission. Replaying the kernel transition produced the same omega digest. The admitted Bitcoin tip is stored on the restart snapshot.

Rust and the kernel agree on ten residual rows, not one. Nonce 0 is `0.02519000125198503`. Nonce 6 is `0.0002011002025239986`. The other rows move difficulty, work, pressure, timestamp, a 2^53−1 nonce, and one transaction. `canonical_coinbase` at that nonce-6 residual is 99 at height 1 and 100 at height 0. `cargo test --lib` passed 80 tests. One consensus proof test is ignored.

Contract storage on the artifacts node is not Ω.wasm. Changing a contract cell changes the operational root. It does not change an evidence header whose state root was supplied. Replacing a contract cell with `local` left the kernel wasm leaf at `none`. A block that carried wasm entries `cell=from-call` also left that leaf at `none`. This node executes that call through `executeKernelWasm` and stores the map it returns. It still does not accept a supplied map as Ω.wasm. Both `wasmLeafOf` functions encode a two-entry map as `a=1|b=2`. A storage cache passed to the kernel without a wasm call in the evidence is ignored. A wasm call in the evidence, with the storage that call produced, does change the state root. That is the authorized path.

A genesis document whose `chain_id` is `equilibrium-1` and whose allocations are the seven kernel lines is the kernel's Ω before any block. It does not insert a synthetic height-0 hash. Height stays −1. The measured ledger was 114,000,000. Treasury `ecd8dc4f62c29edfd4fe4b89d7abf971a2e7bef3` held 8,000,000. The foundation miner `ac083abd5150fd0050050b5cb2e1593c39cf9866` held 1,500,000 liquid and 500,000 bonded. Each of the three activity keys held 1,500,000. The four genesis validators were credited that same liquid and registered at those bonds, commission 0.1. The two kernel pools are present: EQU-WBTC 10,000,000/100 and EQU-USDC 10,000,000/10,000,000. The admission target on that document is 8e-4, not the library constant 2e-3. A residual of 0.001 at height 1 pays 79 against 8e-4 and 99 against 2e-3. Three `applySuccessor` steps and three `addBlock` steps, given the same prev, nonce 6, pressure 0, and the miner, agreed. Rewards were 0, then 1, then 99. Liquids were 0, then 0, then 9. Finalized heights were −1, −1, then 0. Difficulty stayed 1,000,000. The ledger ended at 114,000,009. A UTXO of 50 and a contract cell were present on the artifacts side. The operational root was not the kernel state root. The reward, the liquid, every validator's accumulated rewards, `blocksProposed`, the difficulty, and the finalized height still matched. The height-0 reward is 0 because cumulative work is 0 and the continuity term is 1. The height-1 reward of 1 paid no liquid, and every floor of that 1 across the 5,500,000 of bonds is 0, so it was unminted. `buildGenesisChain` is still the 25-block demo. It is not this document.

`governance.params.baseReward` is still 50,000,000 and `miningThreshold` is still 1e-8. Neither number is read by the coinbase or by difficulty. A block whose coinbase is 99 still pays 9 liquid and 45 accumulated rewards to each of two equal bonds, and the next difficulty stays 1,000,000, whether those parameters are left at the defaults or moved. Executing a passed `baseReward` proposal left `params.baseReward` at 50,000,000 and `couplings.structural` at 1. A block field that named λ_structural 0 did not change the couplings. A passed kernel proposal did: the next canonical residual of the nonce-6 header moved from `0.0002011002025239986` (fingerprint 201,100,202,523,998) to 0 (fingerprint 0). A claim 1e-12 above that residual fingerprints to 201,100,203,523,998 and is refused. Admission compares those integers. A passed kernel proposal does not rewrite the residual of the block that carries it. That block kept residual `0.0002011002025239986`. The proposal writes the next couplings into Ω, and the omega digest changes. The following block is where the residual moves, if it is given those couplings. With λ_structural set to 0 the residual was 0 and the reward was 99. With λ_structural left at 1 the residual was `0.14415143210725334` and the reward was 0. The artifacts parameter object is not that proposal. A gossiped body is paid only when this process recomputes the same residual and it is under the target. It is not paid 50,000,000, and it is not paid `canonicalCoinbase` of an unchecked claim. HTTP submit does the same recompute. The gossip recompute uses pressure 0 and an empty transaction list.

The phone tip is the EQ-07 string of the fields it has. The frozen header, built as that UTF-8 preimage, hashes to `836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306`. Rust `canonical_identity` matches it. A JSON `hash` that is not that identity is rejected. Continuity stores those 32 bytes, not `block_hash`. A phone that does not know the post-state root fills the merkle root and the state root with 64 zero bytes. That preimage — nonce 6, residual fingerprint 201,100,202,523,998, miner `a`×20, height 1, pressure `0.000000` — hashes to `321f0875386d44ac469e4e3c957f82317a9705da6ec7972885888c93f56cdc39`. It is not `795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2`. The phone admission check recomputes the canonical residual at pressure 0. A territory residual does not pass. HTTP submit still stores the node's sealed hash. A BFT vote, if a block carries one, is still checked over the four-field digest. The artifacts transition does not create those votes. `cargo test --lib mobile_validator` passed 26 tests. The Kotlin source was not run on a device. The same UTF-8 string was hashed in Node.

Finality is the same lag on both bodies. Live bonded stake at or above 2/3 of total bonded stake finalizes height − 2. Jailed and slashed stake stays in the denominator. Three successive kernel blocks from height −1 finish at height 2 with finalized height 0. A block produced from height 2 finalizes height 1. One jailed validator out of three equal bonds still meets 2/3. Two excluded validators do not, and finalized height stays −1. The artifacts node records an empty vote list. Registered validator keys do not sign, do not move uptime, and do not burn stake. An explicit slash call does not burn a bond. The tip stays unfinalized.

### Still open

- Operational `addBlock` is still not `applySuccessor`, and it refuses a block that carries evidence. The evidence path is the successor. One mainnet block with a double-sign slash, the Bitcoin genesis header, an admitted Ethereum header, and a wasm `init` was sealed on both bodies. The header was `ab7d2b0ee7e170e5574ae1cddbcfbdf996bc8352b519baf9564d05b0cc0c5743`. The omega root was `8a55c33ae15a3eb0fa8c54c4c370309bfe3e48b8225d9a65d91dbe017c723b86`. The header binds the transition digest of (Ω, I). The omega digest includes the pool address, because that address is how a transfer becomes a swap, and it includes the stored validator, proposal, ballot, and foreign-header fields. `tipHash` stays outside it. The frozen thirteen-field vector, which omits the transition digest, is unchanged. The slash took a bond from 1,500,000 to 1,425,000 and jailed the validator. The wasm map was `owner` plus `paused=0`. The next difficulty was 991,517. Replay reproduced it. The reward at nonce 6 was 0. `f64` portability is still open.
- A block's couplings must be the couplings `openOmega` just wrote. Any other vector is refused, on the site membrane and inside `applySuccessor`. The artifact replay uses that same opened vector. The miner must already be a live validator; a stranger is refused, and two live validators are two states. Committed pressure outside `[0, 1]` is refused. The receiver does not substitute its own mempool. Admission compares `floor(R × 1e18)`, not a `1e-12` window. A timestamp before the tip is refused. Replay uses the wall clock for the future window, not the block's own timestamp. Nonce changes Ω only through the residual it produces. `f64` across machines is still open.
- A peer block is a candidate, not a tip. A proposal is staged until the successor installs it. Mining does not bond a missing producer. Installation compares the omega digest, not only the tip hash. EQ-09 installs the chain with the lower sum of `residualFp` from the common ancestor, including a block that arrives second. An equal sum yields to the smaller tip hash. A successor whose parent tip moved while it was computing is not installed. A finalized ancestor is not reorganized.
- The UTXO set is still there. A UTXO-model fee is no longer a second output. A UTXO of 50 sitting in the set did not change the split above.
- Contract storage and Ω.wasm are not the same map. A supplied wasm list does not write the kernel map. Both bodies store the map the kernel wasm call returns. An empty call still leaves the map empty.
- `governance.params` is still not a kernel proposal. `baseReward` and `miningThreshold` are no longer written by `executeProposal`. Other parameter keys still are. Couplings change only when a passed kernel proposal says so, and they apply to the next residual.
- The phone preimage is the EQ-07 string of the fields it has. A zero state root is not the artifacts seal. When the candidate carries transactions, its merkle root is those transactions, not 64 zero bytes. The phone residual check is the canonical residual at pressure 0. A territory residual is refused. Mobile is not a second producer.
- The grid is these ten rows on this machine. It is not a proof about every platform's `f64`. Admission compares `floor(R × 1e18)`. On the public nonce-6 vector that integer is `201100202523998`. Exact real arithmetic of the same formula is a different protocol. The formula is unchanged. `addBlock` does not pay a matured unbond, and it refuses a pool transaction. Committed pressure is block evidence. A receiver does not replace it with its own mempool. `addBlock` installs canonical Ω only when the block is the successor. If that successor refuses the block, the operational body does not move either. A rollback restores both. A snapshot carries Ω. An accepted successor is copied onto the operational ledger, pools, validators, delegations, couplings, difficulty, finality, and the foreign, model, and settlement rows. A reorganization switches only when each new block is that successor; a refusal puts both bodies back. A coupling changes only when a passed proposal admitted as evidence is opened by the next successor, not from `kernelProposals`. A stranger does not move it. Mobile residual uses the body's committed pressure and fees. A proof is admitted only when it names the residual and state root the successor computed. A model enters Ω only by that same recomputed commitment, which is not a circuit transcript. Foreign settlement moves EQU already on the ledger. The phone may search. It does not install Ω. A node is marked persisted only after the body is written. An independent key can pay another, the process can die, and the payee can pay it back. A valid transfer list in a noncanonical order is refused. A transaction hash that is not the signature preimage is refused. A miner spend that exists only because this block credited the miner's fee is refused. The phone candidate carries the merkle of the transactions it was given. A Groth16 transcript and the RISC Zero hash-fold do not admit a block. `201100202523998` and the reference `201100202523995` are the same side of the mainnet threshold. A negative delegation, a zero delegation, a negative proposal deposit, and an unsafe amount-plus-fee are refused before Ω changes. Negative stake is not a legal start, so it cannot distort the reward denominator. Governance authority is the live validator set at the start of the transition: one vote, at that stake, against that quorum. A delegation, claim, or slash in the same input does not manufacture a larger vote. A caller-supplied wasm map is refused. Replay refuses a transition digest that is not the digest of this (Ω, I). Rust agrees with site on the shared residual, the λ-weighted residual, the header, and the coinbase contract. It rebuilds those digests from a state the site already produced. It also applies that successor on the mainnet surface membrane.run.ts enumerates, including one composed transition. S6 is closed on that surface and not beyond it. A valid second Bitcoin header was not available; a header that does not extend the tip is refused. Other networks were not run. Android was not run. This is not a proof about every byte string. The frozen ten-field and thirteen-field header vectors still omit transitionRoot. No APK was produced by this commit. The Android search still uses the default coupling unless the body names all five weights. No APK was produced by this commit. `/api/light` names the commit, the wasm, and the normalized digest of the output the process is serving. The independent build of b33625e28a2f52adc1b21befcba969537e3c54fd is `4743ee74f910f0f34d94457956aebcc8288a0bde3e531a4a7798f43f223a6a8f`, and the live process reports that digest. The build date, the Node major, a random handler id, and absolute route paths are not part of it. No APK was produced by this commit. Android was not run.
- Floor dust on the stake split is unminted. The reward of 1 at height 1 was entirely dust. It is not a later payment from the same block.
- `optimize_full` is still not admission. `compute_coinbase_reward` is still not the block path.
- An Ethereum header is admitted only when the committee key verifies a signature over the header and the 64-byte participation bitset, the popcount of that bitset is at least 342, and the slot extends the tip. The participant count is that popcount. It is not a field the producer may assert beside the signature. A raw `ethTipHash` does not move difficulty. The admitted tip does, and both bodies use that same factor.
- A foreign block nonce is an exact u64. The decoder accepts a bigint, a safe integer, or strict decimal text. It refuses a missing value, a fraction, a sign, a leading zero, and an unsafe JavaScript number. It does not substitute 0. The site search still walks a uint32 and the result that enters the block is that integer as a bigint. HTTP submit and the P2P body use the same decoder. Signed PostgreSQL BIGINT cannot store 2^64−1, so `blocks.nonce` is `numeric(20,0)` and comes back as a bigint. The corpus 0, 1, 2^53, 2^53+1, 2^53+2, and 2^64−1 was inserted, reloaded, hashed, and passed through `applySuccessor` on PGlite, which reports PostgreSQL 18.3. `persistBlock` against a PostgreSQL server was not run here. The nonce-6 fingerprint is still 201100202523998. This is not an Android result, and it is not artifact 4743ee74.
- The phone solver still searches. The nonce it returns is no longer written into a signed `Long`. JNI writes the decimal text, the body carries that text, and the mobile parser accepts `2^53+1` and `2^64−1` as those integers. `u64::MAX as i64` is still `-1`; that cast is not on this path. The parser tests passed on the host. Workflow run 37311323996 on commit `560b26a9fe77fb21f3d99cbf55b372951cc2ae14` passed the site constitution and uploaded signed `app-release.apk` as artifact `11346598794`. The file's sha256 is `03764ca79e21735d9fbae5cd00d30e4828a2eaa0e6d3609a58790117d09b3b08`. `libequilibrium_core.so` is in the APK for `arm64-v8a`, `armeabi-v7a`, and `x86_64`. Those libraries contain `decode_u64_decimal`, `parse_wire_u64`, `solveBlock`, and the text `nonce is not a u64`. The decimal `18446744073709551615` and the text `Solver nonce is not a u64` are in `classes.dex`, not in the native libraries. An APK Signature Scheme v2 block is present. The release was not published. The APK was not installed and was not executed. It does not apply the successor and it does not install Ω. `versionName` is `0.2.0`. This is not artifact `4743ee74…`.
- An admin call to `slashValidator` does not burn a bond. The staking-contract slash route does not call the contract. A slash of canonical validator state is stake evidence inside the successor. Contract storage is still a separate map.
- This node executes the kernel wasm call. The map that call returns is `Ω.wasm` on both bodies. A supplied entry list does not replace it.
- This is not production-ready.

The sections below describe the repository. They are not a claim that each of those organs is the live kernel.

---

## What is Proof-of-Stationarity?

Proof-of-Stationarity replaces energy-wasting hashing with a **Lagrangian optimization problem**. Miners compete to find the stationary point of a dynamically generated cost function — a point where the gradient vanishes. Block quality is measured by the **residual** (how close to true stationarity the solution is). Lower residual = better block. This makes mining:

- Computationally lightweight (solvable on a mobile phone)
- Mathematically verifiable in microseconds
- Tunable for difficulty without wasted energy

---

## Repository Layout

```
variational-ai/           # AI solver crate (Rust)
  Cargo.toml              # Three binaries: variational-ai, variational-ai-cli, variational-ai-harness
  .cargo/config.toml      # Determinism flags: target-cpu=generic, -C target-feature=-fma
  src/
    lib.rs                # Module declarations
    action.rs             # Action trait (evaluate, gradient, hessian_vec_prod)
    deterministic.rs      # f64 helpers + i64 fixed-point arithmetic (FIXED_SCALE = 1e12)
    logistic.rs           # LogisticAction — binary logistic regression (Newton-CG)
    mlp.rs                # MlpAction — two-layer ReLU MLP (L-BFGS)
    ntk.rs                # NtkAction, solve_ntk (CG), compute_empirical_ntk_mlp
    solver.rs             # StationarySolver (Newton-CG), LbfgsSolver (two-loop L-BFGS)
    mnist.rs              # load_synthetic_mnist() + load_real_mnist() (IDX reader)
    benchmarks.rs         # run_logistic_variational, run_mlp_variational, run_ntk_benchmark
    jni_bridge.rs         # JNI exports for Android (feature-gated: jni-bridge)
    main.rs               # Benchmark runner — tries real MNIST, falls back to synthetic
    bin/
      cli.rs              # variational-ai-cli: stdin JSON → NTK residual verify → stdout JSON
      harness.rs          # variational-ai-harness: SHA-256 determinism conformance harness

equilibrium/              # Rust core library + binaries
  src/
    chain_state.rs        # Block and transaction state machine
    stationary_solver.rs  # Lagrangian optimizer (the "mining" engine)
    consensus.rs           # Proof-of-Stationarity block validation
    zk_proof.rs             # ZK proof stubs (Arkworks/Groth16)
    p2p.rs                   # libp2p networking layer
    ffi.rs                    # C-ABI FFI for Android/iOS integration
    crypto.rs                  # SHA-256 / SHA-512 utilities
    wallet.rs                   # Ed25519 keypair, address derivation, signing
  testnet/node/main.rs    # Testnet node binary
  src/bin/wallet.rs        # CLI wallet binary
  mobile/android/            # Android Gradle project (Kotlin + JNI)

artifacts/
  api-server/             # TypeScript Express node (in-memory chain, auto-miner)
  explorer/               # React + Vite block explorer + browser wallet
  mockup-sandbox/         # Design sandbox, not part of the running stack

lib/
  api-spec/               # OpenAPI 3.1 contract (source of truth)
  api-client-react/       # Generated React Query hooks (Orval)
  api-zod/                # Generated Zod validation schemas (Orval)
  db/                     # Drizzle ORM schema

scripts/
  start-postgres.sh              # Idempotent DB bootstrap (role + schema + grants)
  generate-android-keystore.sh   # keytool-first PKCS12 keystore generation
  load-test.js                   # k6 load test (50 VUs, real Ed25519 signed txs)

docs/
  grafana/                 # Prometheus config + Grafana dashboards + docker-compose
  mobile-apk-release.md    # Android APK signing and sideload distribution guide
  zk-circuit.md            # Groth16 circuit specification
  incentive-model.md       # Miner incentive model analysis
  testnet-deployment.md    # Node deployment guide

.github/workflows/
  ci.yml                   # Site organism, then workspace checks. Rust is the shared contract, not G.
  android-apk.yml          # Site constitution, then the subordinate APK build
android-apk-ci.yml          # Inactive copy. Do not replace .github/workflows/android-apk.yml with it.
```

---

## Architecture Notes

The TypeScript API server **is** the interactive testnet. It **does** talk to the Rust mesh layer by spawning `p2p-sidecar` and communicating with it over NDJSON via `p2p-bridge.ts`:

- The explorer, browser wallet, and everything at `/api/*` run on `artifacts/api-server`'s TypeScript `ChainState` + Postgres. This is what you interact with when you run the project.
- After every mined block, the API server calls `p2pBridge.gossipBlock()`, which forwards the block hash to the sidecar for Gossipsub propagation. Inbound sync/light-node requests from the sidecar are handled back in the TS chain.
- `equilibrium/` (the Rust crate) is a standalone consensus engine with its own `testnet-node` and `wallet` binaries, and mobile FFI exports.

The TypeScript stack is the live testnet (full explorer, wallet, REST API, Postgres persistence). The Rust crate is the reference consensus engine and mobile SDK. Address derivation (`SHA-256(pubkeyHex).slice(0,40)`) and ZK public-input encoding (`fpEncode`, `blockHashToFields`) are kept in sync across both.

---

## Running Locally

### Node + Explorer (TypeScript stack)

Both services start automatically in this environment via the configured workflows. To run manually:

```bash
# API node (port 8080, auto-mines a block every 15 seconds)
# ALLOW_RANDOM_MINING=true is required in dev/testnet so the in-process TS
# miner can run without the real consensus-api Rust binary (see LIMITATIONS §7).
DATABASE_URL=postgresql://runner@127.0.0.1:5432/equilibrium PORT=8080 \
  ALLOW_RANDOM_MINING=true \
  pnpm --filter @workspace/api-server run dev

# Block explorer + wallet (port 5000)
PORT=5000 BASE_PATH=/ pnpm --filter @workspace/explorer run dev
```

### Rust testnet node

```bash
cd equilibrium
cargo run --bin testnet-node
```

### Rust wallet CLI

```bash
cd equilibrium
cargo run --bin wallet -- generate
cargo run --bin wallet -- send --to <addr> --amount <n>
```

### Docker

```bash
docker build -t equilibrium-node .
docker run -p 8080:8080 equilibrium-node
```

### After a container reset

Replit recycles the container on long idle or plan changes. Node modules and
the rustup-managed toolchain are not persisted. Run:

```bash
bash scripts/setup-replit.sh
```

This is idempotent — safe to run any time. It:
1. Reinstalls Node dependencies (`pnpm install`)
2. Installs the pinned Rust 1.97.0 + `wasm32-unknown-unknown` target (needed to rebuild WASM contracts after source changes)
3. Pushes the Drizzle schema to the managed Postgres database

Then start workflows in order: **Postgres → API Server → Explorer**.

> **Rebuilding a WASM contract** after changing Rust source:
> ```bash
> bash contracts/cross_chain_relay/build.sh   # or model_registry / arbitrage
> ```
> The toolchain setup only needs to be run once per container lifetime.

### Required environment variables (development)

| Variable | Value | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://runner@127.0.0.1:5432/equilibrium` | Postgres connection |
| `ALLOW_RANDOM_MINING` | `true` | Allows the in-process TS miner; omit in production where the real Rust solver is required |
| `NODE_ENV` | `development` | Enables non-production code paths |
| `ADMIN_KEY` | any secret string | Enables admin-gated routes (slash, relay register, threshold, challenge) |

> **Postgres socket directory:** The Replit container does not have `/run/postgresql/`. The `start-postgres.sh` script sets `unix_socket_directories = '$PGDATA'` via `.pgdata/replit.conf` to redirect the Unix socket to the data directory. This is handled automatically by the Postgres workflow; no manual steps needed.

---

## API

The node exposes a REST API documented in `lib/api-spec/openapi.yaml`.

Regenerate client hooks after changing the spec:

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Chain

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/chain/status` | Height, TPS, mempool, difficulty, finalized height |
| GET | `/api/chain/stats` | Per-block stats history (last 50 blocks) |
| GET | `/api/chain/finality` | BFT finality status and recent voting rounds |
| GET | `/api/network/peers` | Connected peer list with sync state |
| GET | `/healthz` | Health check |

### Blocks & Transactions

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/blocks` | Paginated block list |
| GET | `/api/blocks/:hashOrHeight` | Block detail |
| GET | `/api/blocks/:hashOrHeight/fees` | Per-block fee breakdown: coinbase, account-model fees, swept UTXO fees, total miner earnings |
| POST | `/api/blocks/submit` | Submit a solved PoS block — validates residual threshold, ±300s drift guard, `prevHash:nonce` replay rejection; broadcasts `new_block` over WebSocket; persists to Postgres |
| GET | `/api/tx/:hash` | Transaction detail |
| POST | `/api/tx/broadcast` | Submit a signed transaction (triggers Gossipsub propagation) |
| GET | `/api/mempool` | Pending transaction pool |

### Addresses

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/address/:addr` | Balance, nonce, transaction history |

### UTXO model

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/utxo/:address` | Unspent outputs and balance for an address |
| GET | `/api/utxo/:txHash/:outputIndex` | Specific UTXO detail |
| GET | `/api/utxo/stats` | UTXO set size and total supply |
| POST | `/api/utxo/build` | Coin selection for a spend (returns inputs/outputs/fee) |
| POST | `/api/utxo/spend` | Broadcast a UTXO transaction; fee credited to next block's miner |

### Smart Contracts (WASM)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contracts` | List deployed contracts |
| GET | `/api/contracts/examples` | Example contract bytecode/ABI |
| GET | `/api/contracts/:address` | Contract detail |
| GET | `/api/contracts/:address/storage` | Contract storage dump |
| GET | `/api/contracts/:address/events` | Rolling event log (last 200 `log()` calls) |
| POST | `/api/contracts/deploy` | Deploy WASM bytecode |
| POST | `/api/contracts/:address/call` | Call a contract method. When `caller` is set, `publicKey` + `signature` (Ed25519 over `"contract-call:{address}:{methodId}:{caller}"`) are required — prevents impersonation of fund-holding addresses |

### Arbitrage Contract

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/arbitrage/opportunities` | Bellman-Ford scan of live DEX pools; cached 4s |
| GET | `/api/arbitrage/status` | Contract address, active model, paused/circuit-tripped state |
| POST | `/api/arbitrage/set-model` | Bind a ModelRegistry model (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/pause` | Pause execution (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/unpause` | Resume + clear circuit breaker (requires `X-Admin-Key`) |
| POST | `/api/arbitrage/execute` | Trigger on-chain arbitrage trade (owner-only at contract level; circuit breaker + hard cap apply; also rate-limited to 2 calls/15s per caller at the route level, independent of the contract's shared circuit breaker) |

### CrossChainRelay Contract

Federated m-of-n cross-chain attestation. Bonded relayers sign inbound state commitments; fraudulent attestations can be challenged and slashed within a configurable window.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/relay/info` | Contract address, m-of-n threshold, registered relayer set |
| POST | `/api/relay/register` | Register a relayer and bond EQU into escrow (requires `X-Admin-Key`) |
| DELETE | `/api/relay/register/:addr` | Revoke a relayer and return their bond (requires `X-Admin-Key`) |
| PATCH | `/api/relay/threshold` | Update m-of-n signing threshold (requires `X-Admin-Key`) |
| POST | `/api/relay/attest/inbound` | Submit an m-of-n signed inbound attestation (permissionless; contract verifies every signature) |
| GET | `/api/relay/attest/inbound/:chainId/:seq` | Attestation status, commitment hash, signers, and block height |
| POST | `/api/relay/attest/inbound/:chainId/:seq/finalize` | Finalize an unchallenged attestation after the challenge window (permissionless) |
| POST | `/api/relay/attest/inbound/:chainId/:seq/challenge` | Slash all signers of a fraudulent attestation (requires `X-Admin-Key`) |
| POST | `/api/relay/outbound/:chainId` | Publish an outbound state commitment (caller must be a registered relayer) |
| GET | `/api/relay/outbound/:chainId/seq` | Current outbound sequence number for a chain |

### Models (ModelRegistry)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/models` | List all proposed/verified/challenged models |
| POST | `/api/models/:id/verify` | Verify a model after its challenge window (re-runs NTK residual via CLI) |
| POST | `/api/models/:id/challenge` | Challenge a model with competing support data; slashes bond on success |

### EVM Compatibility

| Method | Path | Description |
|--------|------|-------------|
| POST | `/evm` | EVM-style JSON-RPC endpoint (chain ID 1337) |
| GET | `/evm/chainid` | EVM chain ID |
| GET | `/evm/accounts` | EVM-format account listing |

### Validators & Staking

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/validators` | Active validator set with bonded stake and uptime |
| GET | `/api/validators/:addr` | Validator detail + slash history |
| GET | `/api/validators/:addr/fees` | Per-block miner fee income for this validator |
| GET | `/api/validators/:addr/earnings` | Aggregate coinbase + fee totals |
| POST | `/api/validators/:addr/slash` | Slash a validator (requires `X-Admin-Key` header — accepts `ADMIN_KEY` or `ADMIN_API_KEY`; superseded by on-chain multisig when configured) |
| GET | `/api/staking/summary` | Global staking stats |
| GET | `/api/stake/:address` | Delegator's staking positions and unbonding queue |
| POST | `/api/stake` | Bond EQU to a validator |
| POST | `/api/unstake` | Begin unbonding (10-block period) |

### DEX AMM

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dex/pools` | All liquidity pools with price and TVL |
| GET | `/api/dex/pools/:id` | Pool detail with liquidity positions |
| GET | `/api/dex/quote` | Price quote before swap |
| POST | `/api/dex/swap` | Execute a swap (constant-product AMM, 0.3% fee) |
| POST | `/api/dex/liquidity/add` | Add liquidity to a pool |
| GET | `/api/dex/swaps` | Recent swap history |
| GET | `/api/dex/positions/:provider` | Liquidity positions for an address |

### Network & Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Node sync state and peer heights |
| GET | `/api/sync/headers` | Headers-first block sync (`?from=N&to=M`, max 200) |
| GET | `/api/gossip` | Recent Gossipsub propagation events |

### Developer Tools

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/faucet` | Drip 1,000 EQU to any address (1h cooldown) |
| GET | `/api/faucet/status/:address` | Faucet cooldown status |
| GET | `/metrics` | Prometheus metrics — chain, validators, staking, DEX, mempool, UTXO pending fees |
| GET | `/metrics/stratum` | Prometheus metrics — Stratum pool: connections, sessions, per-IP rejection counters |

### Mobile

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/mobile/version` | Publish a new APK version for the in-app update check (admin) |
| GET | `/api/mobile/version/latest` | Latest published APK version and download URL |

---

## Block Explorer

Available at `/` in the running preview. Pages:

- **Dashboard** — live height, TPS, mempool pressure, residual quality, network sparkline, latest blocks and transactions
- **Blocks** — paginated block list with consensus fields (height, hash, miner, reward, residual, age)
- **Block detail** — full header, miner, transactions, and Miner Fee Breakdown panel (coinbase reward + account-model fees + swept UTXO fees = total miner earnings)
- **Transaction detail** — from/to, amount, fee, gas, confirmation status
- **Address** — balance, nonce, full transaction history
- **Mempool** — live pending pool with pressure meter and broadcast dialog
- **Network** — connected peers, latency coloring, sync height
- **Validators** — active validator set with stake shares, commission, uptime, and slash history; per-validator detail with Fee Earnings tab showing block-by-block miner fee income
- **Governance** — submit and vote on proposals (text or parameter-change); live quorum/tally bars; chain parameters panel; auto-executes on passage; Ed25519-signed votes verified server-side
- **Faucet** — 1,000 EQU drip per address per hour; live cooldown status
- **Wallet** — self-custody Ed25519 wallet (BIP-39 mnemonic, raw keypair, private key import, AES-256-GCM keystore, Ledger via WebHID, m-of-n multisig, transaction signing and broadcast)
- **Smart Contracts** — WAT textarea editor, in-browser wabt compile, ABI editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage viewer, bytecode hash
- **DEX** — liquidity pool overview, swap interface (constant-product AMM), add liquidity, swap history, per-address liquidity positions, live Arbitrage Opportunities panel (Bellman-Ford cycle detection, 15s refresh)
- **Models** (`/models`) — permissionless AI model registry; propose a model with a staked bond, verify after the challenge window, or challenge with matching support data to slash a fraudulent claim; countdown timer, proposer info, status badges
- **Arbitrage** (`/arbitrage`) — active model binding, recent profit history, circuit-breaker status, owner pause/unpause controls; execution is contract-gated (see `LIMITATIONS.md`)
- **Cross-Chain Relay** (`/relay`) — live view of the CrossChainRelay WASM contract: m-of-n threshold, registered relayer set with bond status, and an attestation lookup tool (enter chain ID + sequence number to inspect status, commitment hash, signers, and finalization block); auto-refreshes every 15s
- **Staking** — personal staking dashboard for delegating to validators
- **Admin** — multisig proposal management (`/admin/multisig`)

All data refreshes every 10 seconds via React Query; WebSocket pushes instant cache invalidation on new blocks.

---

## Wallet

Available at `/wallet`. Fully self-custody, browser-side.

- **Create — Seed phrase (recommended):** BIP-39 mnemonic (12/24-word) + SLIP-0010 Ed25519 HD derivation (`m/44'/600'/account'/0'/index'`), mnemonic-confirmation step, optional AES-256-GCM (PBKDF2, 100k iterations) encrypted keystore in `localStorage`.
- **Create — Raw keypair:** single Ed25519 key, no recovery phrase.
- **Import:** restore from a 64-char hex private key, a mnemonic, or an encrypted keystore file.
- **Hardware wallet:** Ledger support via WebHID/WebUSB transport (`wallet/ledger.ts`).
- **Multi-sig:** m-of-n Ed25519 threshold signing (`WalletMultisig.tsx`, `createMultisigAddress` / `signForMultisig` / `verifyMultisigThreshold`).
- **Send:** builds and signs a transaction, broadcasts to the mempool.
- **Balance:** live balance and nonce from the chain, recent transaction history.

Address derivation: `SHA-256(raw_pubkey_bytes).slice(0, 20)` rendered as 40 hex chars — identical to the Rust wallet.

---

## Consensus

### Adaptive Difficulty

After each block the node recomputes the difficulty threshold based on the rolling average block time (last 10 blocks). Target is **15 seconds**. Adjustment capped at ±20% per block:

```
newDifficulty = currentDifficulty × (targetBlockTime / avgBlockTime)
               clamped to [0.80×, 1.20×] of currentDifficulty
```

### Finality

Live bonded stake at or above 2/3 of total bonded stake finalizes height − 2. The artifacts node does not invent validator votes and does not slash from a participation schedule. An explicit slash does not burn a bond. The tip is not final.

### Validator Set & Slashing

Four genesis validators start with bonded stake. A slash of that set is stake evidence inside the successor: double-sign burns 5% and jails, downtime burns 1%. `POST /validators/:addr/slash` and `POST /api/staking/contract/slash` do not burn that bond.

### ZK Proof of Stationarity

`chain/zkproof.ts` generates a Groth16-shaped proof over the residual using real BN254 elliptic-curve scalar multiplication via `@noble/curves/bn254`. The `pi_a` and `pi_c` points are genuine G1 curve points; `pi_b` is a G2 dummy pending full Groth16 pairing verification. `chain/zk-encoding.ts` is the single source of truth for encoding residuals and block hashes as BN254 field elements — used by both the TS prover and the Rust `consensus-api` binary so public inputs are always bit-identical.

---

## DEX (Automated Market Maker)

Two pools are seeded at genesis: `EQU-WBTC` and `EQU-USDC`. The AMM uses the constant-product formula:

```
x × y = k        (0.3% fee applied to amountIn)
```

Features: swap, add liquidity, price quotes with impact calculation, swap history, and per-provider liquidity positions.

### Arbitrage Detection

`GET /api/arbitrage/opportunities` scans live DEX pool reserves for negative-weight cycles using a Rust Bellman-Ford detector (`variational-ai/src/arbitrage.rs`, exposed as the `variational-ai-arbitrage-cli` binary and invoked from the API server exactly like the residual-verification CLI). Each opportunity reports the token cycle, implied profit factor, and an optimal trade size computed via `StationarySolver`. The Explorer's Dex page shows a live "Arbitrage Opportunities" panel refreshing every 15s.

`pnpm --filter @workspace/scripts run seed-arbitrage-demo` seeds a synthetic mispriced WBTC-USDC pool (dev-only, in-memory, resets on restart) so the panel has a real cycle to display without waiting for genuine market drift.

### Arbitrage Execution (contract-gated)

`POST /api/arbitrage/execute` triggers a real on-chain arbitrage trade via the `Arbitrage` WASM contract. The contract's safety rails are the load-bearing defense:

- **Hard trade cap** — `arbitrageMaxTradeAmount` (governance-controlled, bounded 1M–1T base units); exceeded amounts are rejected before any swap occurs
- **Rolling circuit breaker** — max 5 executions per `arbitrageWindow` block window; the contract auto-pauses if the limit is hit and requires owner unpause to resume
- **Live model check** — the configured ModelRegistry model must be `Verified` and past the `arbitrage_model_update_delay` maturity period; a slash takes effect immediately (non-cached)
- **Owner restriction** — `execute_arbitrage` is owner-only; the contract checks `is_owner()` as the first gate so the caller must be authenticated and match the stored owner address
- **Atomic settlement** — trade is a single `dex_multi_swap` host call; there is no reentrancy window between quoting and settling

Admin routes (`set-model`, `pause`, `unpause`) additionally require the `X-Admin-Key` header (same `ADMIN_KEY`/`ADMIN_API_KEY` pattern as validator slashing). See `LIMITATIONS.md` for the known no-rollback behavior when a swap clears but undershoots the caller's minimum-profit target.

---

## Staking

`POST /api/stake` and `POST /api/unstake` require the delegator's Ed25519 signature over that exact request. A 40-hex address is not enough. Neither route writes the ledger or the bonded set. Both return that the action is evidence inside the successor, not a local write. The canonical stake evidence is `delegate`, `claim`, `slash`, `propose`, and `vote`. It has no unbond edge, so the old 10-block return is not a successor transition.

---

## Smart Contracts & EVM

- `chain/wasm.ts` implements a deterministic WASM execution environment using Node's built-in `WebAssembly` — contract deploy, storage get/set, gas accounting.
- `routes/evm.ts` exposes an EVM-shaped JSON-RPC endpoint (chain ID `1337`) with address/block/transaction format translation for Ethereum tooling.

---

## Networking

### P2P Sidecar (`p2p-sidecar`)

The `equilibrium/src/bin/p2p-sidecar.rs` binary runs as a subprocess of the API server and drives the real libp2p stack. The TypeScript server communicates with it via NDJSON over stdio (`p2p-bridge.ts`).

| Protocol | Role |
|----------|------|
| **Gossipsub** | Block-hash propagation; block bodies fetched on demand |
| **mDNS** | Local peer discovery |
| **Identify** | Peer capability and address exchange |
| **Kademlia (server mode)** | DHT for peer routing |
| **Light-node RR** | Remote peers can request compact SMT proofs |
| **Sync RR** | Remote peers can request block headers and bodies |
| **TCP + QUIC** (`OrTransport`) | Dual transport; QUIC port is `P2P_PORT + 1` by default |

Bootstrap peers are configured via `P2P_BOOTSTRAP` (multiaddr list). The sidecar emits `listen_addr` events so the TS layer can log and expose advertised addresses.

### Transaction Gossip

Broadcasted transactions are forwarded to all connected peers via Gossipsub. All gossip events are logged at `GET /api/gossip`.

### Headers-First Block Sync

Nodes catching up can fetch block headers in bulk via `/api/sync/headers?from=N&to=M` (up to 200 per request). Full block bodies fetched individually via `/api/blocks/:height`.

---

## Security & Rate Limiting

### HTTP submission (`POST /api/blocks/submit`)

- Per-IP sliding-window rate limit (10 req/min)
- `prevHash:nonce` replay rejection (bounded LRU set)
- ±300s timestamp drift guard
- Hex-only miner address validation

### Stratum mining pool (`STRATUM_PORT`)

- Per-session rate limit (6 shares/10s), keyed by TCP socket `remoteIp` (not self-reported miner address — closes the spoofing vector)
- `jobId:nonce:extraNonce2:ntimeHex` duplicate-share rejection
- Per-IP connection cap (max 8 concurrent sockets per address)
- Proof validation: residual < 1e-7, ntime drift check, dedup, rate limit
- Stratum error codes: 20 for rate-limit/drift, 22 for duplicate share

### Contract call caller authentication

- `POST /api/contracts/:address/call` requires an Ed25519 signature whenever `caller` is set in the request body
- Request must include `publicKey` (64 hex chars, raw Ed25519) and `signature` (128 hex chars) over the canonical message `"contract-call:{address}:{methodId}:{caller}"`
- Route verifies that the public key hashes to the claimed caller address and that the signature is valid before passing `callerAddr` to the WASM VM — prevents impersonation attacks where an attacker names a victim address to debit their bond or bypass owner gates
- Calls without a `caller` field (read-only queries, stateless methods) proceed without a signature

### Admin auth

- `POST /api/validators/:addr/slash` requires `X-Admin-Key` header
- `POST /api/arbitrage/set-model`, `/pause`, `/unpause` also require `X-Admin-Key`
- `POST /api/relay/register`, `DELETE /api/relay/register/:addr`, `PATCH /api/relay/threshold`, and `POST .../challenge` all require `X-Admin-Key` — registration is admin-gated to prevent bond-theft attacks where an attacker could drain a victim's balance by forging their address as the caller
- Accepts both `ADMIN_KEY` and `ADMIN_API_KEY` environment variable names
- Superseded by the native on-chain WASM M-of-N multisig when `ADMIN_MULTISIG_ADDRESS` is configured — single key is fallback only

### CORS & general rate limiting

- `ALLOWED_ORIGINS` env var restricts CORS to a validated, comma-separated allowlist; fails closed when set
- Global `readLimiter` (300/min) + `writeLimiter` (20/min) applied across all endpoints

---

## Prometheus Metrics

### `/metrics` — Chain & Network

| Metric | Type | Description |
|--------|------|-------------|
| `equilibrium_chain_height` | Gauge | Current chain height |
| `equilibrium_chain_finalized_height` | Gauge | BFT-finalized height |
| `equilibrium_chain_finality_lag` | Gauge | Blocks behind finalized tip |
| `equilibrium_chain_difficulty` | Gauge | Current adaptive difficulty |
| `equilibrium_chain_avg_block_time_seconds` | Gauge | Rolling average block time (last 10 blocks) |
| `equilibrium_chain_target_block_time_seconds` | Gauge | Target block interval (15s) |
| `equilibrium_chain_tps` | Gauge | Transactions per second |
| `equilibrium_chain_last_residual` | Gauge | Lagrangian residual of latest block |
| `equilibrium_chain_total_tx_count` | Counter | Total confirmed transactions |
| `equilibrium_mempool_size` | Gauge | Pending transaction count |
| `equilibrium_mempool_pressure` | Gauge | Mempool fullness ratio (0–1) |
| `equilibrium_utxo_pending_fees` | Gauge | UTXO-model fees accrued since last block (awaiting sweep to miner) |
| `equilibrium_peers_total` | Gauge | Known peers |
| `equilibrium_peers_connected` | Gauge | Connected peers |
| `equilibrium_validators_active` | Gauge | Active validator count |
| `equilibrium_validators_jailed` | Gauge | Jailed validator count |
| `equilibrium_validators_slashed` | Gauge | Slashed validator count |
| `equilibrium_staking_total_bonded` | Gauge | Total bonded EQU across all validators |
| `equilibrium_validator_bonded_stake` | Gauge | Per-validator bonded stake (label: moniker) |
| `equilibrium_validator_uptime` | Gauge | Per-validator uptime ratio (label: moniker) |
| `equilibrium_validator_blocks_proposed` | Gauge | Blocks proposed per validator (label: moniker) |
| `equilibrium_validator_accumulated_rewards` | Gauge | Accumulated rewards per validator (label: moniker) |
| `equilibrium_validator_slash_count` | Gauge | Slash events per validator (label: moniker) |

### `/metrics/stratum` — Mining Pool

| Metric | Type | Description |
|--------|------|-------------|
| `equilibrium_stratum_enabled` | Gauge | 1 if pool is running, 0 if `STRATUM_PORT` is unset |
| `equilibrium_stratum_active_connections` | Gauge | Current TCP connection count |
| `equilibrium_stratum_active_sessions` | Gauge | Current authenticated miner sessions |
| `equilibrium_stratum_connections_by_ip` | Gauge | Live connection count per remote IP |
| `equilibrium_stratum_rate_limit_rejections_total` | Counter | Total rate-limit rejections |
| `equilibrium_stratum_rate_limit_rejections_by_ip` | Counter | Rate-limit rejections per remote IP |
| `equilibrium_stratum_duplicate_share_rejections_total` | Counter | Total duplicate share rejections |
| `equilibrium_stratum_duplicate_share_rejections_by_ip` | Counter | Duplicate share rejections per remote IP |
| `equilibrium_stratum_connection_cap_rejections_total` | Counter | Total per-IP connection cap rejections |
| `equilibrium_stratum_connection_cap_rejections_by_ip` | Counter | Cap rejections per remote IP |

---

## Grafana Monitoring Stack

Three pre-built dashboards in `docs/grafana/`, wired to `/metrics` and `/metrics/stratum`:

- **Chain Overview** — height, finality lag, TPS, mempool pressure, block time vs. target, peer count, PoS difficulty, UTXO pending fees
- **Validators & Staking** — active/jailed/slashed counts, total bonded stake, per-validator stake/uptime/rewards/slash events
- **Stratum Mining Pool** — connections/sessions, per-IP rejection counters for rate-limit, duplicate share, and connection cap abuse

To spin up the full Prometheus + Grafana stack (dashboards and datasource auto-provisioned):

```bash
# Edit prometheus.yml to set the API target host, then:
cd docs/grafana
docker compose up -d
# Grafana → http://localhost:3000  (admin/admin)
# Prometheus → http://localhost:9090
```

---

## Android APK (Sideload Distribution)

The Android miner is a subordinate residual search (`search_canonical`), not a second successor and not the Render organism. The active workflow is `.github/workflows/android-apk.yml`. It runs the site constitution, then cross-compiles `equilibrium/` and signs the APK. The root file `android-apk-ci.yml` is an inactive copy; do not install it over the active workflow. Run 37311323996 on `560b26a` produced `app-release.apk` (`03764ca79e21735d9fbae5cd00d30e4828a2eaa0e6d3609a58790117d09b3b08`) and did not publish a release. That file was not installed and was not executed. The phone still does not install Ω.

1. Cross-compiles the Rust core for `arm64-v8a`, `armeabi-v7a`, `x86_64` via cargo-ndk
2. Builds and signs the release APK with a PKCS12 keystore
3. Uploads the APK as a GitHub Actions artifact and attaches it to GitHub Releases on `mobile-v*` tags
4. On tagged releases, posts version metadata to `/api/mobile/version` for in-app update notifications

See `docs/mobile-apk-release.md` for keystore generation, secret setup, and distribution steps.

---

## variational-ai Engine

The `variational-ai` crate is the AI solver and on-chain verification engine. It ships three compiled binaries and a TypeScript bridge so the API server can call into deterministic Rust without embedding any native code in Node.

### Binaries

| Binary | Purpose |
|--------|---------|
| `variational-ai` | Benchmark runner — trains logistic, MLP, and NTK models on MNIST; prints accuracy, residual, and time |
| `variational-ai-cli` | **Verification binary** — reads a JSON request from stdin, re-runs the deterministic NTK solver on the support set, and returns `{computed_residual_fp, computed_residual_f64, valid}` to stdout |
| `variational-ai-harness` | Determinism conformance — trains all three model types, hashes every intermediate vector with SHA-256, and prints the hashes. Run on two architectures and diff the output. |

### Building

```bash
cd variational-ai
cargo build --release
# Binaries land in target/release/
```

The harness is the canonical cross-arch verification tool:

```bash
./target/release/variational-ai-harness
# LOGISTIC_THETA=<sha256>  MLP_THETA=<sha256>  NTK_ALPHA_FP=<sha256>  ALL_PASS=true
```

### TypeScript Bridge

`artifacts/api-server/src/variational-ai/bridge.ts` exposes `computeResidual(req)` and `verifyResidual(req)` — async wrappers that spawn `variational-ai-cli` as a subprocess, pipe JSON via stdin, and parse the response. The CLI binary is copied to `artifacts/api-server/variational-ai-cli` at build time.

### Determinism Guarantees

- `.cargo/config.toml` pins `target-cpu=generic` and `-C target-feature=-fma` to prevent FMA instruction differences across CPUs.
- Fixed-point arithmetic (`FIXED_SCALE = 1_000_000_000_000`) is used for on-chain residual comparison — integer subtraction, no floats in the consensus path.
- Two-run SHA-256 hash equality is verified in CI.

### Models

| Model | Solver | Notes |
|-------|--------|-------|
| `LogisticAction` | Newton-CG | Binary classification; `Parameter = Vec<f64>` |
| `MlpAction` | L-BFGS (m=10) | Two-layer ReLU MLP; forward-pass cached |
| `NtkAction` | CG kernel solve | Empirical NTK; `solve_ntk` solves `(K + λI)α = y`; gradient norm is near-zero at exact solution |

MNIST data: auto-detects IDX files in `variational-ai/data/`; falls back to synthetic Gaussian blobs if not present.

---

## Rust Crate

The `equilibrium-core` crate (not connected to the TS server — see Architecture Notes):

- `ChainState` — block DAG + UTXO-style ledger
- `StationarySolver` — gradient descent Lagrangian optimizer
- `Consensus` — block validation against residual threshold; `choose_fork` uses fixed-point `i64` comparison
- `Wallet` — Ed25519 keypair, Ledger (balance/nonce), Keystore JSON
- `ZkProof` — Arkworks/Groth16 proof stubs (ready for circuit wiring)
- `P2pNode` — libp2p Kademlia + Gossipsub networking
- FFI exports (`create_wallet`, `sign_transaction`, `verify_block`, `solve_block`) for Android/iOS JNI

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI solver | Rust, `nalgebra`, `rand_chacha`, `libm`, fixed-point i64 arithmetic |
| Consensus core | Rust, `ed25519-dalek`, `libp2p`, `ark-snark` |
| Node RPC | TypeScript, Express 5, in-memory chain state + Postgres |
| Persistence | Drizzle ORM, PostgreSQL 16 |
| API contract | OpenAPI 3.1, Orval codegen |
| Explorer/Wallet | React 18, Vite 7, Tailwind CSS v4, React Query, Wouter, Recharts |
| Wallet crypto | `@noble/ed25519` v3, `@scure/bip39`, `@scure/bip32`, Web Crypto API |
| Monitoring | Prometheus exposition format, Grafana 11, `prom/prometheus:v2.52.0` |
| Monorepo | pnpm workspaces, Node.js 20+, TypeScript 5.9 |
| Containerization | Docker (single-image node) |
| Mobile | Kotlin + JNI (Android), Swift Package (iOS), Stratum v1 TCP pool |
| CI/CD | GitHub Actions (typecheck + TS tests + Rust tests + Android APK) |

---

## What's Been Built

### Consensus & Protocol
- Proof-of-Stationarity consensus — Lagrangian optimizer finds gradient-zero solutions; `choose_fork` selects canonical chain by lowest residual using fixed-point `i64` comparison (no floats in the fork-choice path)
- Fixed-point residual arithmetic — residuals stored as `residualFp` (`i64` scaled `1e18`) in Postgres and in memory; `reorganize()` uses BigInt comparison throughout — eliminates float non-determinism in fork choice
- ZK proof of stationarity — real BN254 G1 scalar multiplication; `chain/zk-encoding.ts` is the single source of truth for `fpEncode`/`blockHashToFields` shared by TS prover and Rust `consensus-api` binary
- Governance module — full proposal lifecycle (create → vote → quorum check → auto-execute); stake-weighted voting, quorum 33.4%, Ed25519 signature verification on every vote; hard caps on parameter changes, execution timelock, slash rate-limiting, admin action logging
- Adaptive difficulty — rolling 10-block average block time, ±20% cap per block, 15s target
- BFT finality gadget — Tendermint-style validator vote rounds; block finalized at ≥ ⅔ bonded stake
- UTXO fee collection — `pendingUtxoFees` accumulator swept to block miner on every `addBlock()` call (covering auto-miner, HTTP submit, and Stratum paths); `rollbackToHeight()` restores pool on reorg; no fees burned in either balance model

### Security & Rate Limiting
- HTTP submission hardening — per-IP sliding-window rate limit, `prevHash:nonce` replay rejection (bounded LRU), ±300s timestamp drift guard, hex-only miner address check
- Stratum server hardening — rate-limit key is TCP socket `remoteIp` (not self-reported address); duplicate-share key includes `ntimeHex`; per-IP connection cap (max 8); correct Stratum error codes (20/22); proof validation against the residual threshold
- Admin auth reconciled — `POST /validators/:addr/slash` accepts both `ADMIN_KEY` and `ADMIN_API_KEY`; on-chain WASM M-of-N multisig supersedes single key when configured; fails closed (503) in production if neither key is set
- Contract call caller authentication — `POST /api/contracts/:address/call` requires Ed25519 signature over `"contract-call:{address}:{methodId}:{caller}"` whenever `caller` is set; closes bond-theft (unauthenticated `bond()` debit) and owner-gate bypass on both ModelRegistry and Arbitrage contracts
- Enforced tx signatures — `REQUIRE_TX_SIGNATURES=true`; Ed25519 batch verification wired into UTXO validation and block assembly
- CORS lockdown — `ALLOWED_ORIGINS` env var, origin-allowlist callback check, fails closed when set

### Testing
- **Rust unit tests** — 33 tests (27 in `equilibrium-core` via `cargo test --lib`, 1 ignored, + 6 in `variational-ai` via `cargo test --release`): wallet round-trips/sign/verify, stationary solver bounds/clamp/fixed-point, consensus `choose_fork` including fixed-point comparison, Bellman-Ford negative-cycle detection
- **TypeScript tests** — 245 tests across 8 files (`NODE_ENV=test DATABASE_URL=... pnpm --filter @workspace/api-server test`):
  - `chain.unit.test.ts` — 41 unit tests: hash256, merkleRoot, ZK proof generate/verify, difficulty adjustment, UTXO fee sweep/rollback
  - `api.integration.test.ts` — 32 integration tests via Supertest: full chain/block/tx/submission/UTXO/peer/validator/governance flow including valid votes, wrong signature → 401, address mismatch → 400
  - `contracts.integration.test.ts` — 58 tests: WASM VM deploy/call/storage, gas tracking, ABI persistence, bulk restore, REST API coverage, `contracts.deployer` filter; includes caller-auth signature verification tests
  - `multisig.integration.test.ts` — 19 tests: on-chain M-of-N proposal/approve/execute flow, replay protection, bitmask tracking
  - `models.integration.test.ts` — 19 tests: ModelRegistry propose → verify → challenge → slash flow, challenge window enforcement, bond mechanics
  - `arbitrage.integration.test.ts` — 24 tests: Arbitrage contract set-model/pause/unpause/execute flows, circuit breaker trip and reset, governance cap enforcement, model-verification gate
  - `crosschain.integration.test.ts` — 34 tests: CrossChainRelay register/revoke/threshold, inbound Ed25519 attestation submit/duplicate/bad-seq/finalize/challenge, challenge-window enforcement, multi-sig 2-of-2 attestation, admin-key gate on registration
  - `p2p-sync.integration.test.ts` — 12 tests: peer sync callbacks, light-node proof flow
  - `p2p-mesh.integration.test.ts` — 5 tests: Gossipsub block-hash propagation between nodes (requires compiled p2p-sidecar binary; skip-safe without it)

### Explorer & Wallet
- Block explorer — Dashboard, Blocks, BlockDetail (with Miner Fee Breakdown panel), TxDetail, AddressDetail, Mempool, Network, **Kinetic Block Timeline** (`/matrix` — live 3D view of mined blocks via `@react-three/fiber`; cube size = tx count, material clarity = Proof-of-Stationarity residual, mining particle + camera drift driven by real elapsed time/mempool pressure; graceful WebGL-unavailable fallback) — all pages live with real-time React Query data
- Miner fee breakdown — `GET /api/blocks/:hashOrHeight/fees` endpoint; Explorer panel shows coinbase + account-model fees + swept UTXO fees + total per block
- Validator fee earnings — per-validator "Fee Earnings" tab aggregating block-by-block miner income
- Governance explorer — proposal list, live quorum bars, per-validator tally, chain parameters panel, vote submission with Ed25519 signing
- Testnet faucet — 1,000 EQU drip per address per hour; live cooldown status with 5s poll
- Self-custody browser wallet — BIP-39 mnemonic + SLIP-0010 Ed25519 HD derivation, raw keypair, private-key import, AES-256-GCM encrypted keystore, Ledger via WebHID, m-of-n multisig
- Smart contracts UI — WAT editor, in-browser wabt compile, ABI editor, deploy; deployed contract list → detail pages with ABI-driven call panels, storage viewer, deployer filter and skeleton loading
- Network switcher — badge + dialog in header to switch between mainnet/testnet/custom endpoints, persists to `localStorage`
- Admin dashboard — 4-tab page (Chain Health, Validators, Node, Multisig) with live metrics, gossip log, finality status, Stratum pool stats
- Scientific notation formatting — applied to residual, difficulty, rate, price impact, pool prices throughout the UI
- Timestamp bug fixed — removed double-multiplication in ValidatorDetail and Dex pages (the "56y ago" bug)
- Live arbitrage opportunity panel — Dex page shows Bellman-Ford-detected cycles (token path, profit factor, optimal size) with a 15s refresh
- Arbitrage execution page (`/arbitrage`) — active model binding, recent profit history, circuit-breaker status, owner pause/unpause controls; backed by the live `Arbitrage` WASM contract
- Cross-Chain Relay page (`/relay`) — live relay config (threshold, relayer count, contract address), registered relayer table, and attestation lookup by chain ID + sequence number; polls every 15s
- Wallet landing page guidance — first-time-user explanation of Ed25519 keys, BIP-39 mnemonics, and self-custody model; import paths clearly documented

### CrossChainRelay Contract
- **Rust WASM contract** (`contracts/cross_chain_relay/src/lib.rs`) — no-std, compiled to `wasm32-unknown-unknown`; storage-backed relayer set, bond escrow, inbound attestation queue with per-chain sequence tracking, m-of-n Ed25519 signature verification via the `verify_owner_sig` host import, challenge window enforcement via `block_number()`, outbound sequence counter
- **TypeScript wrapper** (`artifacts/api-server/src/chain/crossChainRelay.ts`) — `registerRelayer`, `revokeRelayer`, `setThreshold`, `submitInboundAttestation`, `challengeInbound`, `finalizeInbound`, `publishOutbound`, `getRelayDetails`, `getInboundStatus`
- **REST routes** (`artifacts/api-server/src/routes/crossChainRelay.ts`) — 10 endpoints; registration is admin-only to close bond-theft griefing; attestation submission is permissionless; finalization is permissionless after the challenge window
- **Auto-deploy on boot** — `deployCrossChainRelayIfNeeded()` in `chain/index.ts`; set `CROSS_CHAIN_RELAY_ADDRESS` to keep the address stable across restarts
- **`block_number()` sync** — `addBlock()` in `state.ts` calls `wasmVM.setBlockHeight(block.height)` so the challenge-window check inside the contract always reflects the current chain tip

### variational-ai Engine
- **Rust crate built and compiled** — all three solver types (LogisticAction/Newton-CG, MlpAction/L-BFGS, NtkAction/CG kernel solve) compile and run on synthetic MNIST; real IDX files supported if placed in `variational-ai/data/`
- **Deterministic math layer** — f64 helpers (`sigmoid`, `softplus`, `dot`, `axpy`, `norm2` via `libm`) + full i64 fixed-point path (`FIXED_SCALE = 1e12`: `to_fixed`, `from_fixed`, `mul_fixed`, `dot_fixed`, `norm2_fixed`, `sigmoid_fixed`, `softplus_fixed`) for bit-exact on-chain verification
- **`variational-ai-cli` binary** — stdin→JSON→NTK residual verify→stdout JSON; exit 0=valid, 1=invalid, 2=error; deployed to `artifacts/api-server/variational-ai-cli`
- **`variational-ai-harness` binary** — SHA-256 hashes every intermediate vector and final parameter set; two-run hash equality verified (determinism confirmed)
- **TypeScript bridge** (`artifacts/api-server/src/variational-ai/bridge.ts`) — `computeResidual()` and `verifyResidual()` async wrappers that spawn the CLI via child_process, pipe JSON stdin, parse JSON stdout
- **NTK math consistency fixed** — `evaluate`/`gradient`/`hessian_vec_prod`/`solve_ntk` are internally consistent: stationarity condition of `S(α) = ½‖Kα−y‖² + (λ/2)αᵀKα` gives `(K+λI)α = y`, so ‖∇S(α*)‖ is machine-epsilon at the exact solution
- **JNI bridge** (`src/jni_bridge.rs`) — `trainLogistic` and `trainNtk` exports for Android, feature-gated behind `jni-bridge`, each wrapped in `catch_unwind`
- **Cargo determinism pins** — `.cargo/config.toml` sets `target-cpu=generic -C target-feature=-fma` for cross-arch bit-exact results
- **L-BFGS descent guard** — two-loop produces non-descent direction? falls back to steepest descent before Armijo line search

### Infrastructure
- Genesis block — `genesis.json`: 7 allocations totalling 95M EQU + 4 validators × bonded stake = 100M supply; real Ed25519 keypairs
- Postgres persistence — Drizzle ORM (blocks, transactions, validators, contracts, faucet_drips, app_releases tables); `start-postgres.sh` is idempotent — unsets Replit's injected `PGHOST`/`PGDATABASE`/`PGPASSWORD`, forces correct user, runs `pnpm install --frozen-lockfile` automatically if `node_modules` is absent (cold-boot safe), survives every container restart
- Chain restoration on restart — `loadBlocksFromDb()` recovers the longest contiguous sequence from height 0 rather than resetting to genesis on any gap; prunes orphaned suffix rows from the DB so subsequent restarts converge instead of re-truncating
- WebSocket subscriptions — real-time `new_block` and `mempool_update` events; explorer cache-invalidates instantly
- Contract-first API — OpenAPI 3.1 spec → Orval → typed React Query hooks + Zod schemas
- CI/CD pipeline — `.github/workflows/ci.yml`: the site constitution (`scripts/organism-check.sh`) is the canonical gate. Workspace typecheck and the old Vitest suite still run. `equilibrium/` is the shared-contract crate, not G.
- Android APK CI — `.github/workflows/android-apk.yml`: site constitution first, then cargo-ndk and the signed release APK. `android-apk-ci.yml` at the repo root is not the active workflow.
- Grafana monitoring stack — `docs/grafana/docker-compose.yml`: one command spins up Prometheus + Grafana with all three dashboards auto-provisioned; `prometheus.yml` targets the live API
- Stratum metrics — `GET /metrics/stratum`: Prometheus-format endpoint for pool abuse monitoring; reports `enabled 0` gracefully when the pool is off
- Load test harness — k6 with real Ed25519-signed txs, 50 VUs; 149 TPS / p95 70ms / 9,009/9,009 accepted over the live Replit dev domain
- DB indexes — `contracts_deployer_idx` and `contracts_deployed_at_idx` added

### Mobile Mining
- Android JNI bridge — `equilibrium/src/jni_bridge.rs`; `MiningWorker.kt` → JNI `solveBlock()` → `POST /api/blocks/submit` with OkHttp (retry on 5xx, no-retry on 409/422)
- iOS Swift Package — `MiningCoordinator.swift` using the BackgroundTasks API with auto-rescheduling
- Stratum v1 mining pool — TCP server in `stratum-server.ts`; starts when `STRATUM_PORT` is set; rate-limited with per-IP caps and abuse counters
- In-app update check — backend `/api/mobile/version` endpoints + Android UI; CI publishes version metadata on APK release

---

## Remaining Work

_Reconciled against `main` on 2026-07-28 — see `TODO.md` for full detail and file pointers._

### In-repo — recently closed

| Item | Resolved |
|---|---|
| **Android in-process swarm** | `p2p_runtime.rs` → `P2PNode.kt` wired; `MiningWorker.kt` polls gossip for race detection; prefers P2P tip cache (`fetchTip`) over HTTP when peers up |
| **Inbound P2P sync CI** | `p2pBridge.onSyncRequest` / `onLightNodeRequest` wired in `initChain()`; covered by `p2p-sync.integration.test.ts` (12 tests) |
| **Durable snapshots → safe pruning** | `safelyPruneOldBlocks()` + snapshot fast-path in `initChain()` |
| **Explorer UI polish** | Block rewards consistent; loading `<Skeleton>` components throughout; `ContractDetail.tsx` on React Query |
| **Fail-closed TS mining** | `mining-policy.ts`: `NODE_ENV=production` or `REQUIRE_REAL_SOLVER=true` throws rather than emitting RNG residuals |
| **G2 proof point validation** | `zkproof.ts`: `isValidG2` validates π_B as a genuine BN254 G2 point; `get_verifying_key` + `verify_groth16_proof` WASM host imports added |
| **P2P mesh CI test** | `p2p-mesh.integration.test.ts` (skip-safe without binary; requires `cargo build --release --bin p2p-sidecar` in CI) |
| **`P2P_BOOTSTRAP` env name** | README corrected; was incorrectly documented as `BOOTSTRAP_PEERS` |

### In-repo — open

| # | Item | What remains |
|---|------|--------------|
| 1 | **Phone lightnode / sync RR client** | `p2p_runtime.rs` has tip cache + JNI; phone cannot yet *request* block bodies from peers — HTTP submit still needed when no peer holds the body |
| 2 | **Phone serves other phones** | `p2p_runtime.rs` has no lightnode or sync RR *server* — a phone can't answer another phone's requests |
| 3 | **P2P mesh CI binary** | `p2p-mesh.integration.test.ts` exists and is skip-safe; needs `cargo build --release --bin p2p-sidecar` CI step to run non-skipped |
| 4 | **Full Groth16 pairing** | TS verifier checks curve membership + public inputs; full pairing lives in Rust sidecar only (see `LIMITATIONS.md` §7) |
| 5 | **zkML / ERC-7992 DeepProve** | Ed25519 inference receipt only; on-chain model-inference circuit not implemented |

### External infrastructure and ops

| Priority | Item | Notes |
|---|---|---|
| 🔴 | Multi-region sentry/validator nodes | Needs Hetzner/AWS provisioning |
| 🔴 | Postgres HA (replication + failover + backups) | Managed service or self-hosted cluster |
| 🔴 | DDoS mitigation / rate limiting at edge | Cloudflare or Hetzner DDoS protection |
| 🔴 | Final security audit | External firm, before public mainnet launch |

---

## Deployment / Infrastructure

The stack is small enough for a single low-cost VPS at testnet scale. **Hetzner** is the recommended default (NVMe-backed, generous EU bandwidth, straightforward Docker deploy):

| Component | Suggested tier | Why |
|---|---|---|
| Testnet all-in-one | CX23 (2 vCPU / 4GB) | Cheapest tier; plenty for the TS chain + explorer |
| API node (split out) | CX33 or CAX21 (ARM) | CAX is best price/performance if x86 not required |
| Postgres | CX43 or AX dedicated | RAM-heavy; dedicated AX often cheaper than CCX post-June-2026 |
| Explorer / static | CX22 or bundle onto API box | Vite build is static |
| Validator seed nodes | Multiple CX23 across regions | Cheap enough for genuine libp2p peer diversity |

**Note:** Hetzner repriced cloud servers significantly in June 2026 (CPX/CCX lines up 113–204%). CX (Cost-Optimized) and CAX (ARM) lines stayed relatively stable. Check [hetzner.com/cloud](https://www.hetzner.com/cloud) before ordering — treat the above as directional, not quotes.

---

## License

MIT
