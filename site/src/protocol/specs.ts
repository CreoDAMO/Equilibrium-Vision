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
      "Mempool pressure, fees, continuity, structural golden-ratio coupling, and hash admissibility are first-class fields of Ω.",
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
      "successor is defined on the inputs it is given. A transfer the sender cannot cover is refused inside the transition. The refusal is not a precondition that only the producer knows.",
      "Difficulty moves by the ratio of the target block time to the actual block time, multiplied by the foreign-tip factor in EQ-20, clamped to 0.8 and 1.2, and does not fall below 100,000.",
      "The wasm host is callArbitrage. It runs the arbitrage module whose sha256 is the evidence code. Any other code is refused. The storage it writes is part of Ω.",
      "Fail closed: no RNG residual, no claimed residual without recompute.",
    ],
  },
  {
    id: "EQ-07",
    title: "Commitment",
    summary: "Header hash binds prev, merkle, state root, nonce, residual, miner, height.",
    body: [
      "This rebuild replaces the territory formula hash256(`block-${height}-${prev}-${now}`).",
      "stateRoot merkle-izes account leaves, pool reserves, and the admitted BTC header tip. Peers and the mempool are outside it.",
    ],
  },
  {
    id: "EQ-08",
    title: "Independent verification",
    summary: "Server, browser, and mobile run the same cheap path.",
    body: [
      "Discovery may be specialised. Verification must not be.",
      "A light body that cannot recompute residual is an observer, not a verifier.",
    ],
  },
  {
    id: "EQ-09",
    title: "Fork choice",
    summary: "Lowest cumulative canonical residual wins.",
    body: [
      "Comparisons use residualFp (floor(R × 1e18)) so ARM and x86 agree.",
    ],
  },
  {
    id: "EQ-10",
    title: "Finality",
    summary: "BFT 2/3 bonded stake. Independent of stationarity.",
    body: [
      "A stationary block can wait. A finalized block has already been stationary.",
      "This kernel uses a two-block lag so the tip can be verified and still unfinalized. That is the visible split.",
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
      "When the producer is a live validator, liquid issuance is floor(reward × commission) and the remainder is staked. The producer's commission is 0.1.",
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
      "This site is the public entry at equilibrium.site: observable projection + live testnet/mainnet kernels.",
      "Mobile is an independent verification body, not a smaller copy of discovery.",
    ],
  },
];
