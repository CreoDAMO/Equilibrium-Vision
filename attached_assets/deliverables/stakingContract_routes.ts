import { Router } from "express";
import { chainState } from "../chain/index.js";
import {
  getStakingContractAddress,
  registerValidatorOnContract,
  delegateOnContract,
  undelegateOnContract,
  completeUndelegateOnContract,
  claimRewardsOnContract,
  distributeEpochOnContract,
  slashValidatorOnContract,
  unjailValidatorOnContract,
  updateCommissionOnContract,
  getValidatorInfoFromContract,
  getDelegationInfoFromContract,
  getActiveSetSnapshot,
} from "../chain/stakingContract.js";
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

// GET /api/staking/contract/validators
router.get("/staking/contract/validators", async (_req, res) => {
  const address = getStakingContractAddress();
  if (!address) return res.status(503).json({ error: "Staking contract not deployed" });

  const snapshot = await getActiveSetSnapshot(chainState.wasmVM);
  return res.json({ count: snapshot.length, address, validators: snapshot });
});

// GET /api/staking/contract/validators/:id
router.get("/staking/contract/validators/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid validator id" });

  const info = await getValidatorInfoFromContract(chainState.wasmVM, id);
  if (!info) return res.status(404).json({ error: "Validator not found" });
  return res.json(info);
});

// GET /api/staking/contract/delegation/:delegator/:validatorId
router.get("/staking/contract/delegation/:delegator/:validatorId", async (req, res) => {
  const delegator = String(req.params["delegator"] ?? "").trim().toLowerCase();
  const validatorId = Number(req.params["validatorId"]);
  if (!/^[0-9a-f]{40}$/.test(delegator)) return res.status(400).json({ error: "Invalid delegator address" });
  if (!Number.isInteger(validatorId) || validatorId < 0) return res.status(400).json({ error: "Invalid validator id" });

  const info = await getDelegationInfoFromContract(chainState.wasmVM, delegator, validatorId);
  if (!info) return res.status(404).json({ error: "Delegation not found" });
  return res.json(info);
});

// POST /api/staking/contract/register
// Body: { caller, commissionBp, moniker }
router.post("/staking/contract/register", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { commissionBp, moniker } = req.body ?? {};
  if (typeof commissionBp !== "number" || typeof moniker !== "string") {
    return res.status(400).json({ error: "commissionBp and moniker are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await registerValidatorOnContract(chainState.wasmVM, caller, { commissionBp, moniker });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/delegate
// Body: { caller, validatorId, amount }
router.post("/staking/contract/delegate", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { validatorId, amount } = req.body ?? {};
  if (typeof validatorId !== "number" || typeof amount !== "number") {
    return res.status(400).json({ error: "validatorId and amount are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await delegateOnContract(chainState.wasmVM, caller, validatorId, amount);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/undelegate
// Body: { caller, validatorId, amount }
router.post("/staking/contract/undelegate", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { validatorId, amount } = req.body ?? {};
  if (typeof validatorId !== "number" || typeof amount !== "number") {
    return res.status(400).json({ error: "validatorId and amount are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await undelegateOnContract(chainState.wasmVM, caller, validatorId, amount);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/complete-undelegate
// Body: { caller, unbondingId }
router.post("/staking/contract/complete-undelegate", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { unbondingId } = req.body ?? {};
  if (typeof unbondingId !== "number") {
    return res.status(400).json({ error: "unbondingId is required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await completeUndelegateOnContract(chainState.wasmVM, caller, unbondingId);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/claim-rewards
// Body: { caller, validatorId }
router.post("/staking/contract/claim-rewards", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { validatorId } = req.body ?? {};
  if (typeof validatorId !== "number") {
    return res.status(400).json({ error: "validatorId is required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await claimRewardsOnContract(chainState.wasmVM, caller, validatorId);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/distribute-epoch
// Body: { caller } — permissionless
router.post("/staking/contract/distribute-epoch", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await distributeEpochOnContract(chainState.wasmVM, caller);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/slash
// Body: { caller, validatorId, slashType, evidenceHash }
router.post("/staking/contract/slash", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { validatorId, slashType, evidenceHash } = req.body ?? {};
  if (
    typeof validatorId !== "number" ||
    !["double_sign", "downtime", "light_client"].includes(slashType) ||
    typeof evidenceHash !== "string"
  ) {
    return res.status(400).json({ error: "validatorId, slashType, evidenceHash are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await slashValidatorOnContract(chainState.wasmVM, caller, validatorId, slashType, evidenceHash);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/unjail
// Body: { caller }
router.post("/staking/contract/unjail", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await unjailValidatorOnContract(chainState.wasmVM, caller);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/staking/contract/update-commission
// Body: { caller, newCommissionBp }
router.post("/staking/contract/update-commission", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { newCommissionBp } = req.body ?? {};
  if (typeof newCommissionBp !== "number") {
    return res.status(400).json({ error: "newCommissionBp is required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await updateCommissionOnContract(chainState.wasmVM, caller, newCommissionBp);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

export default router;
