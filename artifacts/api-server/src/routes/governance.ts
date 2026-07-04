import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

// GET /governance/proposals — list all proposals with live vote tallies
router.get("/governance/proposals", (_req, res) => {
  const summaries = chainState.governance.getSummaries(chainState.totalBondedStake);
  res.json({ count: summaries.length, proposals: summaries });
});

// POST /governance/proposals — submit a new proposal
router.post("/governance/proposals", (req, res) => {
  const { proposer, type, title, description, parameterChange } = req.body as {
    proposer?: string;
    type?: string;
    title?: string;
    description?: string;
    parameterChange?: { key: string; value: number };
  };

  if (!proposer || !type || !title || !description) {
    res.status(400).json({ error: "proposer, type, title, and description are required" });
    return;
  }
  if (type !== "text" && type !== "parameter_change") {
    res.status(400).json({ error: "type must be 'text' or 'parameter_change'" });
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const proposal = chainState.governance.createProposal(
      proposer,
      type as "text" | "parameter_change",
      title,
      description,
      now,
      parameterChange,
    );
    const summary = chainState.governance.getSummaries(chainState.totalBondedStake)
      .find(p => p.id === proposal.id);
    res.status(201).json(summary);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// GET /governance/proposals/:id — single proposal detail with voter breakdown
router.get("/governance/proposals/:id", (req, res) => {
  const p = chainState.governance.getProposal(req.params["id"]!);
  if (!p) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }
  const totalBonded = chainState.totalBondedStake;
  const totalVoted = p.votesYes + p.votesNo + p.votesAbstain;
  res.json({
    ...p,
    // Serialize the Map as an array for JSON transport
    votes: [...p.votes.entries()].map(([address, v]) => ({ address, ...v })),
    quorumReached: totalBonded > 0 ? totalVoted / totalBonded >= 0.334 : false,
    passThreshold: totalVoted > 0 ? p.votesYes / totalVoted > 0.5 : false,
    quorumPct: totalBonded > 0 ? (totalVoted / totalBonded) * 100 : 0,
    totalVotingPower: totalBonded,
    parameterChange: p.parameterChange ?? null,
  });
});

// POST /governance/proposals/:id/vote — cast or change a vote
router.post("/governance/proposals/:id/vote", (req, res) => {
  const { voter, choice } = req.body as { voter?: string; choice?: string };
  if (!voter || !choice) {
    res.status(400).json({ error: "voter and choice are required" });
    return;
  }
  if (!["yes", "no", "abstain"].includes(choice)) {
    res.status(400).json({ error: "choice must be 'yes', 'no', or 'abstain'" });
    return;
  }

  // Voting power = bonded stake only (validators + their delegated stake).
  // Ledger account balance is excluded so quorum math (denominator =
  // totalBondedStake) remains coherent.
  // NOTE: in production the voter field must be verified against a signed
  // payload — for testnet, vote origin is trusted from the request body.
  const validatorRecord = chainState.validators.get(voter);
  let votingPower = validatorRecord?.bondedStake ?? 0;

  if (votingPower <= 0) {
    // Check if voter has delegated stake in any validator
    votingPower = [...chainState.stakes.values()]
      .filter(s => s.delegator === voter && !s.unbonding)
      .reduce((sum, s) => sum + s.amount, 0);
  }

  if (votingPower <= 0) {
    res.status(400).json({ error: "Voter has no bonded stake — only bonded validators and delegators can vote" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const result = chainState.governance.vote(
    req.params["id"]!,
    voter,
    choice as "yes" | "no" | "abstain",
    votingPower,
    now,
  );

  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  const updated = chainState.governance.getSummaries(chainState.totalBondedStake)
    .find(p => p.id === req.params["id"]!);
  res.json({ success: true, proposal: updated });
});

// GET /governance/params — current live chain parameters
router.get("/governance/params", (_req, res) => {
  res.json(chainState.governance.params);
});

export default router;
