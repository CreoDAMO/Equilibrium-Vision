import type { ChainSnapshot } from "./types";

export type ClaimStatus = "survived" | "partial" | "open" | "falsified" | "territory";

export interface Claim {
  id: string;
  title: string;
  original: string;
  prediction: string;
  insideOut: string;
  outsideIn: string;
  closure: string;
  counter: string;
  status: ClaimStatus;
}

export const CLAIMS: Claim[] = [
  {
    id: "C-001",
    title: "Mempool pressure enters the solver",
    original: "P_M = min(|M|/500, 1) is an input to StationarySolver.",
    prediction: "Injecting transactions raises P_M and changes the residual of the next block.",
    insideOut: "The node reads mempool.size, normalizes by 500, and passes it as a coupling.",
    outsideIn: "External transactions (faucet, wallet, simulated actors) increase |M| before the next solve.",
    closure: "Network → mempool → pressure → solve → block → (fees drain mempool) → next pressure.",
    counter: "If ablating λ_mempool leaves residual unchanged under load, the coupling is decorative.",
    status: "partial",
  },
  {
    id: "C-002",
    title: "Stationarity ≠ fork choice ≠ finality",
    original: "Three independent mechanisms.",
    prediction: "A block can be stationary yet unfinalized; fork-choice uses cumulative residual; finality uses 2/3 stake.",
    insideOut: "Solver admits a candidate; BFT votes separately; no code path equates the three.",
    outsideIn: "Explorer shows residual, cumulative residual, and finalized height as distinct fields.",
    closure: "Finality votes are recorded after commit and do not rewrite the residual.",
    counter: "If finality required stationarity or vice versa, the separation would be false.",
    status: "survived",
  },
  {
    id: "C-003",
    title: "VerifyStationaryEvidence is an explicit protocol operation",
    original: "External submission accepted claimed residual without rerunning the solver.",
    prediction: "Every accepted block is independently recomputed: continuity, merkle, residual, threshold, signatures.",
    insideOut: "verifyStationaryEvidence() is called on every compose, not only on gossip.",
    outsideIn: "The Verify body re-runs the same function on the tip without access to miner search.",
    closure: "A failed check marks verified=false; it does not silently become canonical truth.",
    counter: "The original TS POST /blocks/submit path still exists in the source repo — territory, not this node.",
    status: "survived",
  },
  {
    id: "C-004",
    title: "Territory residual saturates; canonical residual stationarizes",
    original: "Rust joint_residual uses raw u64 hash minus difficulty, almost never < 1e-7.",
    prediction: "Faithful territory residual remains huge; dimensionless canonical residual can fall below threshold.",
    insideOut: "Both quantities are computed from the same header. Consensus uses canonical R.",
    outsideIn: "Every block header publishes both residuals. Experiments can plot them independently.",
    closure: "This is a rebuild decision, not a claim that the old solver already worked.",
    counter: "Calling the old residual 'solved' would falsify the audit.",
    status: "territory",
  },
  {
    id: "C-005",
    title: "Committed state ⊂ operational state",
    original: "SMT commits accounts, UTXOs, contract storage — not validators, DEX, mempool, peers.",
    prediction: "stateRoot changes when balances, pool reserves, the BTC tip, the ETH tip, or WASM storage change. A peer disconnect does not.",
    insideOut: "stateRoot merkle-izes account leaves, pool reserves, the BTC tip, the ETH tip, and WASM storage. Peers and announcement hashes stay outside it.",
    outsideIn: "Wholes panel lists committed vs operational vs observed vs whole.",
    closure: "A light node can prove an account or a pool reserve against stateRoot without the peer table.",
    counter: "If a peer disconnect changed the root, or a swap that was included did not, the commitment would be wrong.",
    status: "survived",
  },
  {
    id: "C-006",
    title: "Mobile / light body verifies without rediscovering",
    original: "Expensive solve, cheap re-verify.",
    prediction: "Recomputing residual from (header, txs, pressure) matches claimed R without nonce search.",
    insideOut: "Discovery iterates nonce. Verification evaluates once.",
    outsideIn: "The Verify page, Mobile page, and Android client run the cheap path only.",
    closure: "Agreement is a measurement on the tested path, not a proof of every transition.",
    counter: "If verification required the same iteration budget, the split would be false.",
    status: "survived",
  },
  {
    id: "C-007",
    title: "ZK does not yet prove the canonical transition",
    original: "Groth16/RISC Zero bind residual/threshold/block hash — not Ω_t → Ω_{t+1}.",
    prediction: "No block on this node carries a Groth16 proof of the full transition.",
    insideOut: "Every committed block carries a stationarity relation bound to its own header hash. That relation is not a Groth16 of the solver.",
    outsideIn: "Research page states the limitation in the same words as the source LIMITATIONS.md.",
    closure: "We do not advertise a proof we cannot verify.",
    counter: "Shipping a fake 'valid: true' badge would falsify this claim.",
    status: "open",
  },
  {
    id: "C-008",
    title: "Reward couples to residual",
    original: "Reward = base · min(1/(R+1e-6), 1), with coinomics quality.",
    prediction: "Lower residual yields higher coinbase, saturating at the base reward.",
    insideOut: "composeBlock computes quality from canonical R.",
    outsideIn: "Block pages show coinbase next to residual. Library shows the coinomics curve.",
    closure: "Residual participates in acceptance, reward, and (via history) fork-choice.",
    counter: "A constant coinbase would falsify the coupling.",
    status: "survived",
  },
  {
    id: "C-009",
    title: "Inside → outside without outside → inside is not an organism",
    original: "Bidirectional model is the claim to test, not a decoration.",
    prediction: "Each organ has at least one traced arrow in both directions, or is marked one-way.",
    insideOut: "Solver emits blocks. Wallet emits signed txs.",
    outsideIn: "The browser recomputes R from the published header and compares it to the claim.",
    closure: "The loop page stores G(I) vs I(E) per height. Agreement there is not universal closure.",
    counter: "A marketing diagram with no event stream would fail this claim.",
    status: "partial",
  },
  {
    id: "C-010",
    title: "Rust and TypeScript must not silently redefine the protocol",
    original: "Disagreement is evidence.",
    prediction: "This node publishes where it matches the repo and where it rebuilds.",
    insideOut: "Address derivation SHA-256(pubkey)[..20] matches both stacks.",
    outsideIn: "Header hash here commits merkle, state root, nonce, residual, and pressure.",
    closure: "The difference is listed in the audit, not papered over.",
    counter: "Pretending byte-identity with the Replit miner would be false.",
    status: "territory",
  },
];

export function liveEvidence(snap: ChainSnapshot): Record<string, string> {
  const tip = snap.recentBlocks[0];
  const lag = snap.height - snap.finalizedHeight;
  const paired = snap.lastPaired
    ? `λ_${snap.lastPaired.key} formula ${snap.lastPaired.formulaEffect ? "yes" : "no"} · discovery ${snap.lastPaired.discoveryEffect ? "yes" : "no"} · ΔR ${snap.lastPaired.deltaR.toExponential(2)}`
    : snap.lastWhole
      ? `whole transition · restore ${snap.lastWhole.persistence.restartEqual ? "equal" : "diverged"} · stake ${snap.lastWhole.stake.distributed}`
      : "paired λ not run on this kernel";
  return {
    "C-001": `P=${snap.mempoolPressure.toFixed(3)} · |M|=${snap.mempoolSize} · R=${snap.lastResidual.toExponential(3)} · ${paired}`,
    "C-002": `height ${snap.height} · finalized ${snap.finalizedHeight} · visible lag ${lag} (protocol lag ${snap.finalityLag})`,
    "C-003": snap.lastVerify
      ? `${snap.lastVerify.checks.filter((c) => c.ok).length}/${snap.lastVerify.checks.length} checks on last compose`
      : "no report yet",
    "C-004": `canonical ${snap.lastResidual.toExponential(3)} · territory ${snap.lastTerritoryResidual.toExponential(3)}`,
    "C-005": `state root ${tip?.stateRoot.slice(0, 12) ?? "—"} · pools ${snap.pools.length} · BTC ${snap.btc.tipHeight ?? "none"} · ETH ${snap.eth.tipSlot ?? "none"} · wasm ${snap.wasmStorage.length}`,
    "C-006": snap.lastBidirectional
      ? `discovery ${snap.lastBidirectional.discoveryIters} · verify ${snap.lastBidirectional.verifyEvals} · agree ${snap.lastBidirectional.agree}`
      : "no trial",
    "C-007": tip?.relation
      ? `relation on ${tip.hash.slice(0, 12)} · hashLo ${tip.relation.hashLo} · not a Groth16`
      : "no Groth16 of the transition is attached to any block",
    "C-008": tip ? `coinbase ${tip.coinbaseReward} at R ${tip.residual.toExponential(3)}` : "—",
    "C-009": snap.lastBidirectional
      ? `claimed ${snap.lastBidirectional.claimedR.toExponential(3)} · inferred ${snap.lastBidirectional.inferredR.toExponential(3)} · agree ${snap.lastBidirectional.agree}`
      : "waiting for a tip",
    "C-010": `chain_id ${snap.params.chainId} · header binds P ${tip?.committedPressure.toFixed(3) ?? "—"} · persisted ${snap.persisted}`,
  };
}
