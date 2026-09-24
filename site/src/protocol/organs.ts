/**
 * Application organs from contracts/ and lib/.
 * A live organ participates in this process's transition.
 * A source-only organ does not, and is not badged live.
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
    summary: "The compiled arbitrage.wasm runs inside this process. init, pause, and unpause write contract storage, and that storage is a leaf of the next state root. A WASM swap cannot move the pools; the signed EQU transfer does that.",
    methods: [
      { id: 0, name: "init", note: "executed wasm, stores owner" },
      { id: 2, name: "pause", note: "executed wasm, owner only" },
      { id: 4, name: "execute", note: "host dex_multi_swap refuses; pools stay on the signed path" },
    ],
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
    live: true,
    summary: "Header admission from the Rust contract: proof of work, then prev-hash continuity. An admitted header enters the next state root. No EQU is minted. A transfer proof checks merkle and 6 confirmations and still does not credit.",
    methods: [
      { id: 0, name: "submit_header", note: "PoW + continuity, no credit" },
      { id: 1, name: "verify_transfer", note: "merkle + 6 confirmations, still no credit" },
    ],
  },
  {
    id: "eth_sync_bridge",
    path: "contracts/eth_sync_bridge",
    title: "ETH sync bridge",
    layer: "whole",
    live: true,
    summary: "BLS verification of a beacon-style header, quorum 342/512, then parent continuity. The admitted tip is in the next state root. No EQU is minted. A key this process generates is not Ethereum's sync committee.",
    methods: [
      { id: 0, name: "bootstrap", note: "install an aggregate pubkey" },
      { id: 2, name: "submit_header", note: "BLS + quorum + continuity, no credit" },
    ],
  },
  {
    id: "zkml_verifier",
    path: "contracts/EquilibriumZkmlVerifier.sol",
    title: "ZKML verifier",
    layer: "whole",
    live: true,
    summary: "Every block records the stationarity relation against its own header hash: residual, threshold, and the hash that already binds the state root. A Groth16 proof of the solver executing inside the circuit is still not attached.",
    methods: [{ id: 0, name: "bind", note: "relation on the committed header, not a Groth16 of Ωt → Ωt+1" }],
  },
];
