export interface SpecDoc {
  id: string;
  title: string;
  summary: string;
  body: string[];
}

export const SPECS: SpecDoc[] = [
  {
    id: "EQ-00",
    title: "Canonical",
    summary: "Multiple bodies may implement the protocol. They do not independently redefine it.",
    body: [
      "Equilibrium is a closed, bidirectionally modelled system. The theory is the map. The implementation is the territory.",
      "Canonical operations: Candidate → Stationarity → Verification → Transition → Commitment → Fork-choice → Finality.",
      "If Rust, TypeScript, or mobile disagree, the disagreement is evidence — not a vote.",
    ],
  },
  {
    id: "EQ-01",
    title: "Ontology",
    summary: "Four wholes: committed ⊆ observed ⊆ operational ⊆ whole.",
    body: [
      "Ω_committed — what the state root actually binds.",
      "Ω_observed — what a web, mobile, or light body can perceive.",
      "Ω_operational — everything required to compute the next state.",
      "Ω_whole — everything we say belongs to Equilibrium, including theory and experiments.",
    ],
  },
  {
    id: "EQ-02",
    title: "Living state",
    summary: "State is metabolism: inputs, couplings, regulation, memory, observation.",
    body: [
      "A block is not a row in a ledger. It is a candidate state transition that must satisfy stationarity before it becomes memory.",
      "Mempool pressure is not a field of Ω. It is committed block evidence. A producer may observe min(|M| / 500, 1) and seal that number. The successor and every receiver use the sealed number. They do not read the mempool.",
    ],
  },
  {
    id: "EQ-03",
    title: "Candidate",
    summary: "Assembly of ≤ 50 signed transactions plus a header template.",
    body: [
      "Signatures are re-verified at assembly. Invalid txs are dropped, not mined.",
      "A transfer is applied only when the sender's balance covers the amount and the fee. Otherwise there is no next state, and no second output is created.",
      "Merkle root is computed before discovery. The solver does not invent the transaction set after the fact except via the fee coupling in the territory solver.",
    ],
  },
  {
    id: "EQ-04",
    title: "Stationary discovery",
    summary: "Expensive search for a nonce that drives canonical residual below threshold.",
    body: [
      "Canonical residual is dimensionless: hash fraction, |h − 1/φ|, continuity, mempool pressure, fee coverage.",
      "Territory residual (raw u64 hash term from stationary_solver.rs) is computed and published but is not the admission quantity — it saturates.",
    ],
  },
  {
    id: "EQ-05",
    title: "Stationary verification",
    summary: "Cheap re-evaluation. No search.",
    body: [
      "VerifyStationaryEvidence(B, Ω) → {continuity, timestamp, merkle, residual-recompute, threshold, signatures}.",
      "This was the open protocol issue in the source recap. This node makes it mandatory.",
    ],
  },
  {
    id: "EQ-06",
    title: "Transition",
    summary: "Balances, nonces, fees, coinbase, validator rewards, difficulty.",
    body: [
      "Account model is canonical. Coinbase is credited on that ledger and is not also created as a second output.",
      "successor is defined on the inputs it is given. A transfer the sender cannot cover is refused inside the transition. The refusal is not a precondition that only the producer knows. A negative, zero, or unsafe delegation is refused. A proposal deposit must be a non-negative safe integer. amount + fee must itself be a safe integer. Governance authority is the live validator set at the start of the transition. A later delegation, claim, or slash in that same input does not change who may vote, how much, or the quorum. A vote is spent once.",
      "An operational block installs canonical Ω only when it is that successor. The transactions in that block must be the canonical fee-and-nonce order of that same list. A higher fee does not jump a missing nonce, and a reversed list of otherwise valid transfers is refused. The receiver's mempool is not an input. The install replaces the operational ledger, pools, validators, delegations, couplings, difficulty, finality, wasm, proposals, models, settlements, and foreign headers with that Ω′. A miner who is not a live validator does not move Ω. If the successor refuses the block, the operational body does not move either. A rollback restores both. A snapshot carries Ω, not only the operational ledger. A reorganization switches only when every new block is admitted by that same successor; otherwise both bodies stay.",
      "Difficulty moves by the ratio of the target block time to the actual block time, multiplied by the foreign-tip factor in EQ-20, clamped to 0.8 and 1.2, and does not fall below 100,000.",
      "The coinbase target is the network residual threshold. Mainnet is 8e-4. Testnet is 2e-3. At height 1, a residual of 0.001 pays 79 against the mainnet target and 99 against the testnet target.",
      "The wasm host is callArbitrage. It runs only inside successor. applySuccessor does not accept a caller-supplied storage map. Any other code is refused. The storage execution writes is part of Ω.",
      "Fail closed: no RNG residual, no claimed residual without recompute.",
    ],
  },
  {
    id: "EQ-07",
    title: "Commitment",
    summary: "Header hash binds prev, merkle, state root, nonce, residual, miner, height.",
    body: [
      "The header hash is canonicalHeaderHash. It binds the previous hash, the merkle root, the state root, the timestamp, the nonce, the difficulty, the residual fingerprint, the miner, the height, and the committed pressure. It is not hash256(`block-${height}-${prev}-${now}`).",
      "A phone that does not know the post-state fills the state root with 64 zero bytes. The merkle root is the merkle of the transactions the candidate carries, and an empty list is 64 zero bytes. The residual fingerprint in that string is the solver's territory residual. That hash is the phone's tip. It is not the artifacts seal.",
      "When the block carries a chain id, an evidence root, and an omega digest, the preimage also binds those. That longer preimage is a different hash. The state root in that header is the canonical projection supplied with the block. The artifacts operational root is a separate commitment and is not written into that field.",
      "The state root merkle-izes account leaves, pool id, pool address, reserves, fee, and swap count, the admitted Bitcoin tip, the admitted Ethereum tip, wasm storage, model claims, and foreign settlements. A validator-only change does not move it. Pool token names are labels on a native EQU swap into the pool; they are not a second asset the successor prices.",
      "Validator bond, jail, slash, moniker, uptime, delegations, difficulty, proposals (title, proposer, deposit, and the votes already cast), model claims, and settlements are in the omega digest. Bitcoin headers are committed with height, hash, previous hash, merkle root, and bits. Ethereum headers are committed with slot, hash, participants, parent, state, and body. tipHash stays outside the digest because the next header binds it. The state root stays the operational projection: account leaves, pool id, pool address, reserves, fee, and swap count, the admitted tip hashes, wasm, models, and settlements. An evidence header binds the omega digest, the state root, and the transition digest of (Ω, I). A block that names a different transition digest is not that input. Peers, the mempool, device temperature, and the mobile peer book are outside both. Pool token names are labels on a native EQU swap; they are not a second asset.",
      "A residual proof is accepted only when it names the residual fingerprint and the state root this transition computed. That binding is the proof. A Groth16 transcript or a RISC Zero hash-fold is not this computation and does not admit a block. A model enters Ω only when G recomputes its commitment. That commitment is not a circuit transcript. A challenge that disagrees, and whose commitment G recomputes, marks the claim slashed. It does not prove the model false.",
      "Foreign settlement locks EQU already on the ledger against a Bitcoin or Ethereum observation already in Ω, then releases that same EQU. It does not mint.",
    ],
  },
  {
    id: "EQ-08",
    title: "Independent verification",
    summary: "Server, browser, and mobile run the same cheap path.",
    body: [
      "Discovery may be specialised. Verification must not be.",
      "A light body that cannot recompute residual is an observer, not a verifier.",
      "A phone may solve only while it is cool enough and charged enough. That decision stays on the device. The nonce it finds is a candidate. The organism admits it, or it does not. Heat does not enter Ω.",
      "QR and NFC carry one bootstrap string. The peer book survives a process restart. A peer hello is not a block.",
    ],
  },
  {
    id: "EQ-09",
    title: "Fork choice",
    summary: "Lowest cumulative canonical residual wins.",
    body: [
      "Comparisons use residualFp, which is floor of the specified binary64 evaluation of R, times 1e18. That integer is the protocol. The real-number value of the same formula is not, and it already differs on the public nonce-6 vector.",
      "The chain with the lower sum of residualFp from the common ancestor wins.",
      "If the sums are equal, the chain whose tip hash is lexicographically smaller wins. Arrival order is not a tie-break.",
      "A block that does not extend the current tip is still a candidate. It is not rejected for arriving second.",
      "A successor computed from an older Ω is not installed. The candidate is selected again against the Ω that is current.",
      "A reorganization that admits the candidate through the successor switches both bodies onto that history. A candidate the successor refuses restores both and does not switch. A finalized ancestor is not reorganized. kernelProposals are not a second coupling authority. A coupling changes only when a passed proposal, admitted as stake evidence, is opened by the next successor.",
    ],
  },
  {
    id: "EQ-10",
    title: "Finality",
    summary: "BFT 2/3 bonded stake. Independent of stationarity.",
    body: [
      "A stationary block can wait. A finalized block has already been stationary.",
      "This kernel uses a two-block lag so the tip can be verified and still unfinalized. The artifacts node uses that same quorum and that same lag. It does not invent votes, and it does not slash from a local participation schedule.",
    ],
  },
  {
    id: "EQ-11",
    title: "Network",
    summary: "Circulation. External input is not automatically truth.",
    body: [
      "The membrane: signatures, residual evidence, continuity, replay protection.",
      "libp2p sidecar remains the source-repo body; this site is the observable surface and a live kernel.",
    ],
  },
  {
    id: "EQ-12",
    title: "External submission",
    summary: "No residual claims without VerifyStationaryEvidence.",
    body: [
      "The original POST /blocks/submit structural check (R < 1e-7 without rerun) is not implemented here on purpose.",
      "A claimed residual is offered to VerifyStationaryEvidence. Forgery is rejected at the membrane. Admission of a forged residual is a protocol failure.",
    ],
  },
  {
    id: "EQ-13",
    title: "Implementation conformance",
    summary: "Address derivation matches Rust/TS 5/5 known vectors: SHA-256(pubkey)[..20].",
    body: [
      "Ed25519 signing bytes include chain_id to prevent cross-network replay.",
      "Testnet chain_id = 2. Mainnet chain_id = 1.",
    ],
  },
  {
    id: "EQ-14",
    title: "Evidence",
    summary: "Every block carries breakdown, iterations, both residuals, and a verify report.",
    body: [
      "ZK remains experimental. Residual evidence is not a SNARK of the transition.",
    ],
  },
  {
    id: "EQ-15",
    title: "Experiments",
    summary: "Perturb → observe → measure → recover → compare.",
    body: [
      "Ablation zeros a coupling λ_i and mines one block.",
      "Pressure injects transactions and measures ΔR.",
    ],
  },
  {
    id: "EQ-16",
    title: "Theory interface",
    summary: "δS_closed[Φ, Θ] = 0 is a hypothesis about coupled behaviour, not a proof of this code.",
    body: [
      "If removing a coupling does not change behaviour, the coupling is not doing work.",
    ],
  },
  {
    id: "EQ-17",
    title: "Economic state",
    summary: "Coinbase quality, DEX AMM, genesis allocations.",
    body: [
      "The paid reward is floor(100 × (1/2)^(height / 2,100,000) × min(1, target / (R + 1e-9))). It is not 50,000,000 × min(1/(R + 1e-6), 1).",
      "genesis.json's initial_supply header says 100,000,000. Its seven allocation lines sum to 95,000,000, and the kernel credits the lines. The initial ledger is wider: testnet also credits a 25,000,000 treasury, a 2,000,000 producer of which 500,000 is bonded, three 1,500,000 activity keys, and 5,000,000 of validator stake as liquid. That testnet ledger is 131,000,000. Mainnet uses an 8,000,000 treasury instead, and its ledger is 114,000,000.",
    ],
  },
  {
    id: "EQ-18",
    title: "Validator state",
    summary: "Bonded stake, commission, proposals, BFT votes.",
    body: [
      "When the producer is a live validator, liquid issuance is floor(reward × commission) and the remainder is staked. The producer's commission is 0.1. The staked remainder is split by bonded stake into accumulated rewards. Floor dust is not minted. There is no second participation credit.",
      "A producer who is missing, jailed, or slashed is paid the whole reward as liquid, and nothing is staked.",
      "A double-sign slash burns 5% of bonded stake. A downtime slash burns 1%.",
    ],
  },
  {
    id: "EQ-19",
    title: "Application boundary",
    summary: "DEX and faucet are application organs, not consensus.",
    body: [
      "They may influence mempool and therefore the solver. That influence is measured, not assumed canonical.",
    ],
  },
  {
    id: "EQ-20",
    title: "Cross-chain",
    summary: "A membrane. Foreign commitments are attestations until proven.",
    body: [
      "A verified Bitcoin or Ethereum header is not only stored. The next difficulty is the time rule multiplied by a factor from each foreign tip's last byte. That factor is the integer ratio (9950 + round(byte / 255 × 100)) / 10000, so it stays inside [0.995, 1.005]. The product is then clamped to 0.8 and 1.2 and floored at 100,000.",
      "No foreign tip leaves the time rule unchanged. This rule does not export EQU.",
    ],
  },
  {
    id: "EQ-21",
    title: "Runtime bodies",
    summary: "Rust core, TypeScript node, P2P, Android, light, this site.",
    body: [
      "This site is the public entry at equilibriums.site: observable projection + live testnet/mainnet kernels.",
      "Mobile is an independent verification body, not a smaller copy of discovery.",
    ],
  },
];
