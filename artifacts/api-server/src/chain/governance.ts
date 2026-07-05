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
}

export const DEFAULT_PARAMS: ChainParameters = {
  baseReward: 50_000_000,
  miningThreshold: 1e-8,
  unbondingPeriod: 10,
  maxMempoolSize: 10_000,
  minValidatorStake: 1_000_000,
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
};

/** Quorum: at least 33.4 % of total bonded stake must have voted. */
const QUORUM_PCT = 0.334;
/** Pass: simple majority of participating votes (> 50 %). */
const PASS_PCT = 0.5;
/** Voting window: 7 days expressed in seconds (testnet: 10 minutes). */
const VOTING_WINDOW_S = 600; // 10 min for testnet

/**
 * Execution timelock: mandatory delay between a proposal passing and it being
 * applied on-chain.  Gives token holders time to react to an unexpected result.
 * Testnet: 5 minutes.  Override with GOVERNANCE_TIMELOCK_S env var.
 *
 * The Drift Protocol ($286 M) attack exploited instant execution of pre-signed
 * admin transactions — a timelock would have made it detectable before impact.
 */
const EXECUTION_DELAY_S = Number(process.env["GOVERNANCE_TIMELOCK_S"] ?? 300); // 5 min testnet default

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
