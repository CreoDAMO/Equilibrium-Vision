/**
 * Application organs that already existed in the source repo
 * (contracts/ and lib/) and were not on the public runtime.
 * WASM bytecode is not executed here. Semantics are.
 */

export type OrganLayer = "committed" | "operational" | "observed" | "whole";

export interface ContractOrgan {
  id: string;
  path: string;
  title: string;
  layer: OrganLayer;
  live: boolean;
  summary: string;
  methods: Array<{ id: number; name: string; note: string }>;
}

export const CONTRACT_ORGANS: ContractOrgan[] = [
  {
    id: "staking",
    path: "contracts/staking",
    title: "Staking",
    layer: "committed",
    live: true,
    summary: "Register, delegate, slash, claim. The block producer is bonded. Commission is liquid; the rest of the coinbase is split by stake inside the same transition. Not the WASM bump allocator.",
    methods: [
      { id: 0, name: "register", note: "genesis validators already registered" },
      { id: 1, name: "delegate", note: "debit EQU, raise bondedStake" },
      { id: 2, name: "undelegate", note: "unbonding, not instant" },
      { id: 4, name: "claim_rewards", note: "accumulatedRewards → balance" },
      { id: 6, name: "slash", note: "double-sign 5%, downtime 1% (lib/coinomics)" },
    ],
  },
  {
    id: "governance",
    path: "contracts/governance",
    title: "Governance",
    layer: "operational",
    live: true,
    summary: "Token-weighted proposals. Votes do not rewrite residual. Passed messages can change couplings — that is an experiment, not a proof.",
    methods: [
      { id: 0, name: "submit_proposal", note: "deposit from bonded or liquid" },
      { id: 1, name: "vote", note: "yes / no / abstain" },
      { id: 2, name: "end_voting", note: "quorum + pass threshold" },
      { id: 3, name: "execute_proposal", note: "may set a λ" },
    ],
  },
  {
    id: "model_registry",
    path: "contracts/model_registry",
    title: "Model registry",
    layer: "operational",
    live: true,
    summary: "Optimistic oracle for residual claims on models. Challenge window. Not zkML.",
    methods: [
      { id: 0, name: "propose", note: "commit support-set hash + residualFp" },
      { id: 1, name: "verify_model", note: "finalize after window" },
      { id: 2, name: "challenge", note: "open — no Groth16 of the model" },
    ],
  },
  {
    id: "arbitrage",
    path: "contracts/arbitrage",
    title: "Arbitrage",
    layer: "operational",
    live: true,
    summary: "Variational-AI solver over DEX reserves. Does not sit in the state root.",
    methods: [{ id: 0, name: "scan", note: "read-only over operational pools" }],
  },
  {
    id: "cross_chain_relay",
    path: "contracts/cross_chain_relay",
    title: "Cross-chain relay",
    layer: "operational",
    live: true,
    summary: "Outbound commitments are attestations until proven. Source publishOutbound still accepted caller-supplied hashes — this runtime will not.",
    methods: [
      { id: 0, name: "publish_outbound", note: "records an attestation, not a proof" },
      { id: 1, name: "ingest_inbound", note: "rejected unless evidence verifies" },
    ],
  },
  {
    id: "btc_spv_bridge",
    path: "contracts/btc_spv_bridge",
    title: "BTC SPV bridge",
    layer: "whole",
    live: false,
    summary: "Rust contract exists in the repo. Not a live light-client in this public runtime.",
    methods: [{ id: 0, name: "submit_header", note: "source body only" }],
  },
  {
    id: "eth_sync_bridge",
    path: "contracts/eth_sync_bridge",
    title: "ETH sync bridge",
    layer: "whole",
    live: false,
    summary: "Rust contract exists in the repo. Not a live sync committee verifier here.",
    methods: [{ id: 0, name: "submit_update", note: "source body only" }],
  },
  {
    id: "zkml_verifier",
    path: "contracts/EquilibriumZkmlVerifier.sol",
    title: "ZKML verifier",
    layer: "whole",
    live: false,
    summary: "Solidity verifier for residual/threshold/hash. Does not prove Ωt → Ωt+1. C-007 remains open.",
    methods: [{ id: 0, name: "verify", note: "not wired; would be a false badge" }],
  },
];
