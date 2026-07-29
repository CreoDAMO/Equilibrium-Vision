// ── Governance module ─────────────────────────────────────────────────────────
//
// Implements on-chain governance: proposal lifecycle (create → vote → execute),
// stake-weighted voting (1 EQU bonded = 1 vote), quorum (≥ 33.4 % of total
// supply / bonded stake), and automatic execution of passed parameter changes.
//
// Governance is intentionally kept stateless w.r.t. the chain — it reads the
// live ChainState for voting power and writes back via the parameter-change
// callback.  This lets us unit-test the logic without a full chain.

export type ProposalStatus = "active" | "passed" | "rejected" | "executed";

export type ProposalType =
  | "text"               // signal-only, no on-chain effect
  | "parameter_change";  // mutates a ChainParameters field

export interface ParameterChange {
  key: string;   // e.g. "baseReward", "miningThreshold", "unbondingPeriod"
  value: number;
}

export interface Proposal {
  id: string;
  type: ProposalType;
  title: string;
  description: string;
  proposer: string;
  parameterChange?: ParameterChange;

  // Timing
  submittedAt: number;       // unix seconds
  votingEndsAt: number;      // unix seconds
  readyToExecuteAt?: number; // unix seconds — set when proposal passes, execution delayed until this time

  // Vote tallies (stake-weighted)
  votesYes: number;
  votesNo: number;
  votesAbstain: number;

  // Individual votes: voterAddress → { power, choice }
  votes: Map<string, { power: number; choice: "yes" | "no" | "abstain" }>;

  status: ProposalStatus;
  executedAt?: number;
}

export interface ProposalSummary {
  id: string;
  type: ProposalType;
  title: string;
  proposer: string;
  submittedAt: number;
  votingEndsAt: number;
  readyToExecuteAt?: number;
  votesYes: number;
  votesNo: number;
  votesAbstain: number;
  quorumReached: boolean;
  passThreshold: boolean;
  status: ProposalStatus;
  totalVotingPower: number;
  quorumPct: number;
}

// Mutable chain parameters that governance can modify at runtime.
export interface ChainParameters {
  baseReward: number;       // block reward in base units
  miningThreshold: number;  // max residual accepted for a valid block
  unbondingPeriod: number;  // blocks until stake is returned after unstake
  maxMempoolSize: number;   // max pending tx count
  minValidatorStake: number;// minimum EQU to register as a validator

  // ── ModelRegistry contract parameters ──────────────────────────────────────
  // (base units follow the same 1 EQU = 1_000_000 base-unit scale as
  // minValidatorStake/baseReward above)
  modelRegistryChallengePeriod: number;            // blocks a proposed model can be challenged
  modelRegistryMinimumBond: number;                // base units required to propose a model
  modelRegistryChallengeBond: number;               // base units required to challenge a model
  modelRegistrySlashingFractionBp: number;          // basis points (of 10_000) of proposer bond slashed on a successful challenge
  modelRegistryChallengerRewardFractionBp: number;  // basis points of the slashed amount paid to the challenger
  modelRegistryResidualEpsilonScaled: number;       // max |claimed - computed| residual, fixed-point scaled by 1e12
  modelRegistryMaxModelsPerProposer: number;        // spam guard
  modelRegistryMaxSupportSetSize: number;           // max support-set entries accepted by verify_residual

  // ── Arbitrage contract safety rails ────────────────────────────────────────
  arbitrageModelUpdateDelay: number;   // blocks a newly-verified model must wait before arbitrage may use it
  arbitrageMaxTradeAmount: number;     // base units — cap on value moved per atomic arbitrage execution
  arbitrageWindowBlocks: number;       // rolling window (blocks) used by the circuit breaker's profit check

  // ── Governance WASM contract parameters ─────────────────────────────────────
  // Param names must match the gov_param() calls in contracts/governance/src/lib.rs.
  govMinDeposit: number;        // base units — minimum deposit to submit a proposal
  govVotingPeriod: number;      // blocks — length of the voting window
  govQuorumThreshold: number;   // base units — absolute minimum total vote weight required
  govPassThreshold: number;     // FP × 10^18 — yes must exceed this fraction of total votes (0.5 × 10^18 = 50%)

  // ── Staking WASM contract parameters ────────────────────────────────────────
  // Param names must match the gov_param() calls in contracts/staking/src/lib.rs.
  stakingActiveSetSize: number;       // maximum number of active validators
  stakingMinValidatorStake: number;   // base units — minimum self-bond to join active set
  stakingTargetRatio: number;         // FP × 10^18 — target staked/total-supply ratio (0.67 × 10^18)
  stakingBaseInflationRate: number;   // FP × 10^18 — base annual inflation rate (0.07 × 10^18)
  stakingAdjustmentSpeed: number;     // FP × 10^18 — how fast inflation responds to ratio delta (0.5 × 10^18)
  stakingMinInflationRate: number;    // FP × 10^18 — floor on annual inflation (0.01 × 10^18)
  stakingMaxInflationRate: number;    // FP × 10^18 — ceiling on annual inflation (0.20 × 10^18)
  stakingBlocksPerYear: number;       // e.g. 2_628_000 at ~12 s/block
  stakingEpochBlocks: number;         // blocks per reward epoch
  stakingUnbondPeriod: number;        // blocks — should match TS unbondingPeriod
  stakingMinDelegation: number;       // base units — minimum delegation amount
  stakingSlashDoubleSign: number;     // FP × 10^18 — slash fraction for double-sign (0.05 × 10^18)
  stakingSlashDowntime: number;       // FP × 10^18 — slash fraction for downtime (0.01 × 10^18)
  stakingJailPeriod: number;          // blocks — mandatory jail duration after downtime slash
  stakingSlashReporterReward: number; // FP × 10^18 — fraction of slash paid to reporter (0.01 × 10^18)
  stakingDowntimeThreshold: number;   // missed blocks before automatic downtime slash
  stakingUnjailFee: number;           // base units — fee to unjail a validator
}

export const DEFAULT_PARAMS: ChainParameters = {
  baseReward: 50_000_000,
  miningThreshold: 1e-8,
  unbondingPeriod: 10,
  maxMempoolSize: 10_000,
  minValidatorStake: 1_000_000,

  modelRegistryChallengePeriod: 100,
  modelRegistryMinimumBond: 500_000_000,
  modelRegistryChallengeBond: 200_000_000,
  modelRegistrySlashingFractionBp: 2_000,
  modelRegistryChallengerRewardFractionBp: 2_000,
  modelRegistryResidualEpsilonScaled: 1_000_000,   // 1e-6 * 1e12
  modelRegistryMaxModelsPerProposer: 10,
  modelRegistryMaxSupportSetSize: 2_048,

  arbitrageModelUpdateDelay: 50,
  arbitrageMaxTradeAmount: 100_000_000_000,
  arbitrageWindowBlocks: 100,

  // Governance WASM contract — testnet defaults (short periods for iteration speed)
  govMinDeposit:      500_000,
  govVotingPeriod:    100,                        // blocks
  govQuorumThreshold: 1_000_000,                  // 1 EQU minimum total votes
  govPassThreshold:   500_000_000_000_000_000,    // 0.50 × 10^18

  // Staking WASM contract — economic defaults
  stakingActiveSetSize:       21,
  stakingMinValidatorStake:   1_000_000,           // 1 EQU (matches TS minValidatorStake)
  stakingTargetRatio:         670_000_000_000_000_000, // 0.67 × 10^18
  stakingBaseInflationRate:    70_000_000_000_000_000, // 0.07 × 10^18
  stakingAdjustmentSpeed:     500_000_000_000_000_000, // 0.50 × 10^18
  stakingMinInflationRate:     10_000_000_000_000_000, // 0.01 × 10^18
  stakingMaxInflationRate:    200_000_000_000_000_000, // 0.20 × 10^18
  stakingBlocksPerYear:       2_628_000,           // ~365.25 days @ 12 s/block
  stakingEpochBlocks:         100,
  stakingUnbondPeriod:        10,                  // matches TS unbondingPeriod
  stakingMinDelegation:       100_000,
  stakingSlashDoubleSign:      50_000_000_000_000_000, // 0.05 × 10^18
  stakingSlashDowntime:        10_000_000_000_000_000, // 0.01 × 10^18
  stakingJailPeriod:          1_000,               // blocks
  stakingSlashReporterReward:  10_000_000_000_000_000, // 0.01 × 10^18
  stakingDowntimeThreshold:   10,                  // missed blocks
  stakingUnjailFee:           10_000,
};

/**
 * Hard safety bounds for each governance-controlled parameter.
 * Any proposal whose value falls outside [min, max] is rejected at creation time.
 * This prevents a single passed proposal from setting catastrophic values
 * (analogous to the Resolv $25M mint-with-no-collateral-check exploit).
 */
const PARAM_BOUNDS: Record<keyof ChainParameters, { min: number; max: number }> = {
  baseReward:        { min: 1_000_000,      max: 500_000_000  }, // 0.001 – 500 EQU
  miningThreshold:   { min: 1e-12,          max: 1e-4         }, // tight residual window
  unbondingPeriod:   { min: 1,              max: 50_400       }, // 1 block – ~7 days @ 12 s/block
  maxMempoolSize:    { min: 100,            max: 100_000      },
  minValidatorStake: { min: 100_000,        max: 50_000_000   }, // 0.0001 – 50 EQU

  modelRegistryChallengePeriod:           { min: 1,         max: 500 },
  modelRegistryMinimumBond:               { min: 1_000_000, max: 10_000_000_000 },
  modelRegistryChallengeBond:             { min: 1_000_000, max: 5_000_000_000 },
  modelRegistrySlashingFractionBp:        { min: 100,       max: 5_000 },
  modelRegistryChallengerRewardFractionBp:{ min: 100,       max: 5_000 },
  modelRegistryResidualEpsilonScaled:     { min: 1_000,     max: 1_000_000_000 },
  modelRegistryMaxModelsPerProposer:      { min: 1,         max: 50 },
  modelRegistryMaxSupportSetSize:         { min: 64,        max: 8_192 },

  arbitrageModelUpdateDelay: { min: 1,         max: 1_000 },
  arbitrageMaxTradeAmount:   { min: 1_000_000, max: 1_000_000_000_000 },
  arbitrageWindowBlocks:     { min: 10,        max: 1_000 },

  // Governance WASM contract
  govMinDeposit:      { min: 1_000,         max: 100_000_000_000 },
  govVotingPeriod:    { min: 1,             max: 500_000 },      // 1 block – ~70 days
  govQuorumThreshold: { min: 1,             max: 1_000_000_000_000_000 },
  govPassThreshold:   { min: 1,             max: 1_000_000_000_000_000_000 }, // 0–100% × SCALE

  // Staking WASM contract
  stakingActiveSetSize:       { min: 1,   max: 300 },
  stakingMinValidatorStake:   { min: 1,   max: 1_000_000_000_000 },
  stakingTargetRatio:         { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingBaseInflationRate:   { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingAdjustmentSpeed:     { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingMinInflationRate:    { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingMaxInflationRate:    { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingBlocksPerYear:       { min: 1,   max: 100_000_000 },
  stakingEpochBlocks:         { min: 1,   max: 1_000_000 },
  stakingUnbondPeriod:        { min: 1,   max: 50_400 },
  stakingMinDelegation:       { min: 1,   max: 1_000_000_000_000 },
  stakingSlashDoubleSign:     { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingSlashDowntime:       { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingJailPeriod:          { min: 1,   max: 10_000_000 },
  stakingSlashReporterReward: { min: 1,   max: 1_000_000_000_000_000_000 },
  stakingDowntimeThreshold:   { min: 1,   max: 10_000 },
  stakingUnjailFee:           { min: 0,   max: 1_000_000_000_000 },
};

/** Quorum: at least 33.4 % of total bonded stake must have voted. */
const QUORUM_PCT = 0.334;
/** Pass: simple majority of participating votes (> 50 %). */
const PASS_PCT = 0.5;
// MAINNET SAFETY: all timing parameters are configurable via environment
// variables so testnet (fast) and mainnet (slow) can use the same code.
// Missing env vars fall back to mainnet-safe defaults, NOT testnet speeds.
const IS_TESTNET = process.env["EQUILIBRIUM_NETWORK"] === "testnet";

/** Voting window: 7 days mainnet default, 10 minutes testnet. */
const VOTING_WINDOW_S = IS_TESTNET
  ? 600
  : Number(process.env["GOV_VOTING_WINDOW_S"] ?? 604_800); // 7 days

/**
 * Execution timelock: mandatory delay between a proposal passing and it being
 * applied on-chain.  Gives token holders time to react to an unexpected result.
 * Mainnet default: 2 days.  Testnet: 5 minutes.  Override with GOVERNANCE_TIMELOCK_S.
 *
 * The Drift Protocol ($286 M) attack exploited instant execution of pre-signed
 * admin transactions — a timelock would have made it detectable before impact.
 */
const EXECUTION_DELAY_S = IS_TESTNET
  ? Number(process.env["GOVERNANCE_TIMELOCK_S"] ?? 300)
  : Number(process.env["GOVERNANCE_TIMELOCK_S"] ?? 172_800); // 2 days mainnet default

let proposalCounter = 0;

export class GovernanceModule {
  proposals = new Map<string, Proposal>();
  params: ChainParameters = { ...DEFAULT_PARAMS };

  // Callback invoked when a parameter-change proposal executes.
  private onParamChange?: (params: ChainParameters) => void;
  // Callback invoked when any proposal executes (for admin-action logging).
  private onProposalExecuted?: (p: Proposal) => void;

  constructor(
    onParamChange?: (params: ChainParameters) => void,
    onProposalExecuted?: (p: Proposal) => void,
  ) {
    this.onParamChange = onParamChange;
    this.onProposalExecuted = onProposalExecuted;
  }

  // ── Proposal creation ───────────────────────────────────────────────────────

  createProposal(
    proposer: string,
    type: ProposalType,
    title: string,
    description: string,
    now: number,
    parameterChange?: ParameterChange,
  ): Proposal {
    if (type === "parameter_change" && !parameterChange) {
      throw new Error("parameter_change proposals require a parameterChange field");
    }
    if (parameterChange) {
      const allowed: Array<keyof ChainParameters> = [
        "baseReward", "miningThreshold", "unbondingPeriod", "maxMempoolSize", "minValidatorStake",
        "modelRegistryChallengePeriod", "modelRegistryMinimumBond", "modelRegistryChallengeBond",
        "modelRegistrySlashingFractionBp", "modelRegistryChallengerRewardFractionBp",
        "modelRegistryResidualEpsilonScaled", "modelRegistryMaxModelsPerProposer",
        "modelRegistryMaxSupportSetSize",
        "arbitrageModelUpdateDelay", "arbitrageMaxTradeAmount", "arbitrageWindowBlocks",
      ];
      if (!allowed.includes(parameterChange.key as keyof ChainParameters)) {
        throw new Error(`Unknown parameter: ${parameterChange.key}`);
      }
      if (parameterChange.value <= 0) {
        throw new Error("Parameter value must be positive");
      }

      // Hard safety bounds — reject proposals outside the safe operating range
      const bounds = PARAM_BOUNDS[parameterChange.key as keyof ChainParameters];
      if (parameterChange.value < bounds.min || parameterChange.value > bounds.max) {
        throw new Error(
          `Parameter "${parameterChange.key}" value ${parameterChange.value} is outside ` +
          `the safe range [${bounds.min}, ${bounds.max}]`
        );
      }
    }

    const id = `GOV-${String(++proposalCounter).padStart(4, "0")}`;
    const proposal: Proposal = {
      id,
      type,
      title: title.trim(),
      description: description.trim(),
      proposer,
      parameterChange,
      submittedAt: now,
      votingEndsAt: now + VOTING_WINDOW_S,
      votesYes: 0,
      votesNo: 0,
      votesAbstain: 0,
      votes: new Map(),
      status: "active",
    };

    this.proposals.set(id, proposal);
    return proposal;
  }

  // ── Voting ──────────────────────────────────────────────────────────────────

  vote(
    proposalId: string,
    voter: string,
    choice: "yes" | "no" | "abstain",
    votingPower: number,  // caller supplies bonded-stake of voter
    now: number,
  ): { ok: boolean; error?: string } {
    const p = this.proposals.get(proposalId);
    if (!p) return { ok: false, error: "Proposal not found" };
    if (p.status !== "active") return { ok: false, error: "Proposal is not active" };
    if (now > p.votingEndsAt) return { ok: false, error: "Voting period has ended" };
    if (votingPower <= 0) return { ok: false, error: "No voting power" };

    // Allow vote changes — subtract old vote first.
    const existing = p.votes.get(voter);
    if (existing) {
      if (existing.choice === "yes") p.votesYes -= existing.power;
      else if (existing.choice === "no") p.votesNo -= existing.power;
      else p.votesAbstain -= existing.power;
    }

    p.votes.set(voter, { power: votingPower, choice });
    if (choice === "yes") p.votesYes += votingPower;
    else if (choice === "no") p.votesNo += votingPower;
    else p.votesAbstain += votingPower;

    return { ok: true };
  }

  // ── Block-driven resolution ─────────────────────────────────────────────────

  /**
   * Called once per block.
   *
   * Two-phase execution with timelock:
   *   1. Close active proposals whose voting window has passed → mark "passed"
   *      (with readyToExecuteAt = now + EXECUTION_DELAY_S) or "rejected".
   *   2. Execute proposals that are in "passed" state and whose timelock has elapsed.
   *
   * The timelock means a passed proposal is NOT applied until EXECUTION_DELAY_S
   * seconds after it passed — giving token holders a window to respond.
   */
  processBlock(now: number, totalBondedStake: number): void {
    for (const p of this.proposals.values()) {
      // Phase 2: execute timelocked proposals whose delay has elapsed
      if (p.status === "passed" && p.readyToExecuteAt != null && now >= p.readyToExecuteAt) {
        this.executeProposal(p, now);
        continue;
      }

      // Phase 1: close active proposals whose voting window has ended
      if (p.status !== "active") continue;
      if (now < p.votingEndsAt) continue;

      const totalVoted = p.votesYes + p.votesNo + p.votesAbstain;
      const quorumReached = totalBondedStake > 0
        ? totalVoted / totalBondedStake >= QUORUM_PCT
        : false;
      const passed = totalVoted > 0
        ? p.votesYes / totalVoted > PASS_PCT
        : false;

      if (quorumReached && passed) {
        p.status = "passed";
        p.readyToExecuteAt = now + EXECUTION_DELAY_S;
      } else {
        p.status = "rejected";
      }
    }
  }

  private executeProposal(p: Proposal, now: number): void {
    if (p.type === "parameter_change" && p.parameterChange) {
      const { key, value } = p.parameterChange;
      const k = key as keyof ChainParameters;
      (this.params[k] as number) = value;
      this.onParamChange?.(this.params);
    }
    p.status = "executed";
    p.executedAt = now;
    this.onProposalExecuted?.(p);
  }

  // ── Query helpers ───────────────────────────────────────────────────────────

  getSummaries(totalBondedStake: number): ProposalSummary[] {
    return [...this.proposals.values()].map(p => this.toSummary(p, totalBondedStake));
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  private toSummary(p: Proposal, totalBondedStake: number): ProposalSummary {
    const totalVoted = p.votesYes + p.votesNo + p.votesAbstain;
    const quorumPct = totalBondedStake > 0 ? (totalVoted / totalBondedStake) * 100 : 0;
    return {
      id: p.id,
      type: p.type,
      title: p.title,
      proposer: p.proposer,
      submittedAt: p.submittedAt,
      votingEndsAt: p.votingEndsAt,
      readyToExecuteAt: p.readyToExecuteAt,
      votesYes: p.votesYes,
      votesNo: p.votesNo,
      votesAbstain: p.votesAbstain,
      quorumReached: totalBondedStake > 0 ? totalVoted / totalBondedStake >= QUORUM_PCT : false,
      passThreshold: totalVoted > 0 ? p.votesYes / totalVoted > PASS_PCT : false,
      status: p.status,
      totalVotingPower: totalBondedStake,
      quorumPct,
    };
  }
}
