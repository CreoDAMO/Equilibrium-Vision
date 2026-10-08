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
    summary: "A signed delegate debits EQU and raises bondedStake inside the next successor. A signed unbond releases that delegation into Ω.unbonding and pays the same address when matureAt is reached. The WASM contract's undelegate is not this path.",
    methods: [
      { id: 0, name: "register", note: "genesis validators already registered" },
      { id: 1, name: "delegate", note: "a:D:V:X:PK:SIG or the successor refuses" },
      { id: 2, name: "unbond", note: "u:D:V:X:PK:SIG, pays after unbondingPeriod, not a local queue" },
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
    summary: "A model claim enters Ω only when the successor recomputes its commitment. A later challenge with a different support hash marks it slashed. Neither step is a Groth16 proof of the model.",
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
    summary: "The compiled arbitrage.wasm runs inside this process. init, pause, and unpause are calls in the next block. Replay executes those calls. A WASM swap cannot move the pools; the signed EQU transfer does that.",
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
    summary: "Proof of work, then prev-hash continuity. The header bytes ride in the block that commits the new Bitcoin leaf. No EQU is minted. A signed withdrawal settles only when an output inside that merkle root matches the locked destination and amount. Inclusion alone does not.",
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
    summary: "BLS12-381 verification of the keys a participation bitset selects. Quorum is 342 of 512. The committee rides in the block; the aggregate is derived from it. The secrets do not. No EQU is minted. A committee this process generates is not Ethereum's sync committee.",
    methods: [
      { id: 0, name: "bootstrap", note: "install 512 keys; the aggregate is derived" },
      { id: 1, name: "rotate", note: "the current committee authorizes the next 512 keys" },
      { id: 2, name: "submit_header", note: "subset aggregate + quorum + continuity, no credit" },
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
