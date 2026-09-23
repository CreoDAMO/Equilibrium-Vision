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
      "Account model is canonical for this kernel. UTXO and WASM remain operational in the source repo.",
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
      "Reward = 50,000,000 × min(1/(R + 1e-6), 1).",
      "Genesis supply and validator set taken from the source genesis.json.",
    ],
  },
  {
    id: "EQ-18",
    title: "Validator state",
    summary: "Bonded stake, commission, proposals, BFT votes.",
    body: [
      "Slashing and unbonding exist in the source TypeScript chain; this kernel records stake and proposals.",
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
      "Source CrossChainRelay.publishOutbound() still accepts a caller-supplied commitment. Not wired as consensus here.",
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
