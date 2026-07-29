/**
 * REST routes for the Governance WASM contract
 * (contracts/governance/src/lib.rs and chain/governanceContract.ts).
 *
 * All endpoints live under /api/governance/contract/* to avoid conflicting
 * with the existing TypeScript-layer governance endpoints at /api/governance/*.
 *
 * Proposal lifecycle:
 *   POST /proposals                    → submit_proposal
 *   POST /proposals/:id/vote           → vote
 *   POST /proposals/:id/end-voting     → end_voting  (permissionless)
 *   POST /proposals/:id/execute        → execute_proposal (permissionless)
 *   POST /proposals/:id/cancel         → cancel_proposal  (proposer only)
 *   GET  /proposals                    → list all proposals from contract storage
 *   GET  /proposals/:id                → single proposal
 *   GET  /proposals/:id/vote/:voter    → vote record for a voter
 */
import { Router } from "express";
import { chainState } from "../chain/index.js";
import {
  getGovernanceContractAddress,
  submitProposalToContract,
  voteOnContract,
  endVotingOnContract,
  executeProposalOnContract,
  cancelProposalOnContract,
  getProposalFromContract,
  getVoteFromContract,
} from "../chain/governanceContract.js";
import { logger } from "../lib/logger.js";

const router = Router();

function requireCaller(req: import("express").Request, res: import("express").Response): string | null {
  const caller = typeof req.body?.caller === "string" ? req.body.caller.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(caller)) {
    res.status(400).json({ error: "caller (40-hex-char address) is required" });
    return null;
  }
  return caller;
}

// GET /api/governance/contract/proposals
router.get("/governance/contract/proposals", async (_req, res) => {
  const address = getGovernanceContractAddress();
  if (!address) return res.status(503).json({ error: "Governance contract not deployed" });

  const storage = chainState.wasmVM.getStorage(address);
  const ids = new Set<number>();
  for (const key of Object.keys(storage)) {
    const m = key.match(/^proposal_status:(\d+)$/);
    if (m) ids.add(Number(m[1]));
  }

  const proposals = await Promise.all(
    [...ids].sort((a, b) => a - b).map(async (id) => {
      const info = await getProposalFromContract(chainState.wasmVM, id);
      return info ?? { id, error: "failed to decode" };
    }),
  );

  return res.json({ count: proposals.length, address, proposals });
});

// GET /api/governance/contract/proposals/:id
router.get("/governance/contract/proposals/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  const address = getGovernanceContractAddress();
  if (!address) return res.status(503).json({ error: "Governance contract not deployed" });

  const info = await getProposalFromContract(chainState.wasmVM, id);
  if (!info) return res.status(404).json({ error: "Proposal not found" });
  return res.json(info);
});

// POST /api/governance/contract/proposals
// Body: { caller, title, description, deposit, messages: [{ type, ... }] }
router.post("/governance/contract/proposals", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { title, description, deposit, messages } = req.body ?? {};
  if (
    typeof title !== "string" ||
    typeof description !== "string" ||
    typeof deposit !== "number" ||
    !Array.isArray(messages)
  ) {
    return res.status(400).json({ error: "title, description (strings), deposit (number), messages (array) are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await submitProposalToContract(chainState.wasmVM, caller, { title, description, deposit, messages });
  if (!result.success) return res.status(400).json(result);
  logger.info({ proposalId: result.proposalId, caller }, "governance-contract: proposal submitted");
  return res.json(result);
});

// POST /api/governance/contract/proposals/:id/vote
// Body: { caller, option: "yes" | "no" | "abstain" }
router.post("/governance/contract/proposals/:id/vote", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { option } = req.body ?? {};
  if (!["yes", "no", "abstain"].includes(option)) {
    return res.status(400).json({ error: "option must be yes, no, or abstain" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await voteOnContract(chainState.wasmVM, caller, id, option);
  if (!result.success) return res.status(400).json(result);
  logger.info({ proposalId: id, caller, option }, "governance-contract: vote cast");
  return res.json(result);
});

// POST /api/governance/contract/proposals/:id/end-voting
// Body: { caller } — permissionless
router.post("/governance/contract/proposals/:id/end-voting", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await endVotingOnContract(chainState.wasmVM, caller, id);
  if (!result.success) return res.status(400).json(result);
  logger.info({ proposalId: id, outcome: result.outcome }, "governance-contract: voting ended");
  return res.json(result);
});

// POST /api/governance/contract/proposals/:id/execute
// Body: { caller } — permissionless
router.post("/governance/contract/proposals/:id/execute", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await executeProposalOnContract(chainState.wasmVM, caller, id);
  if (!result.success) return res.status(400).json(result);
  logger.info({ proposalId: id, caller }, "governance-contract: proposal executed");
  return res.json(result);
});

// POST /api/governance/contract/proposals/:id/cancel
// Body: { caller } — must be proposer
router.post("/governance/contract/proposals/:id/cancel", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await cancelProposalOnContract(chainState.wasmVM, caller, id);
  if (!result.success) return res.status(400).json(result);
  logger.info({ proposalId: id, caller }, "governance-contract: proposal cancelled");
  return res.json(result);
});

// GET /api/governance/contract/proposals/:id/vote/:voter
router.get("/governance/contract/proposals/:id/vote/:voter", async (req, res) => {
  const id    = Number(req.params["id"]);
  const voter = String(req.params["voter"] ?? "").trim().toLowerCase();
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid proposal id" });
  if (!/^[0-9a-f]{40}$/.test(voter))   return res.status(400).json({ error: "Invalid voter address" });

  const info = await getVoteFromContract(chainState.wasmVM, id, voter);
  if (!info) return res.status(404).json({ error: "Vote not found" });
  return res.json(info);
});

export default router;
