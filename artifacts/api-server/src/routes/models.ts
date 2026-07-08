/**
 * REST routes for the ModelRegistry WASM contract (see
 * contracts/model_registry/src/lib.rs and chain/modelRegistry.ts). This is a
 * permissionless optimistic oracle — propose/verify/challenge are gated
 * economically by bonds inside the contract itself, not by admin auth here.
 */
import { Router } from "express";
import { chainState } from "../chain/index.js";
import {
  getModelRegistryAddress,
  proposeModel,
  verifyModel,
  challengeModel,
  getModelStatus,
  getModelDetails,
} from "../chain/modelRegistry.js";

const router = Router();

function requireCaller(req: import("express").Request, res: import("express").Response): string | null {
  const caller = typeof req.body?.caller === "string" ? req.body.caller.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(caller)) {
    res.status(400).json({ error: "caller (40-hex-char address) is required" });
    return null;
  }
  return caller;
}

// GET /api/models — list all proposed/verified/slashed models by scanning
// the contract's flat KV storage for model_status:<id> keys.
router.get("/models", (_req, res) => {
  const address = getModelRegistryAddress();
  if (!address) return res.status(503).json({ error: "ModelRegistry not deployed" });

  const storage = chainState.wasmVM.getStorage(address);
  const ids = new Set<number>();
  for (const key of Object.keys(storage)) {
    const m = key.match(/^model_status:(\d+)$/);
    if (m) ids.add(Number(m[1]));
  }

  const models = [...ids].sort((a, b) => a - b).map((id) => {
    const statusCode = Number(storage[`model_status:${id}`] ?? -1);
    const status = statusCode === 0 ? "proposed" : statusCode === 1 ? "verified" : statusCode === 2 ? "slashed" : "unknown";
    return { id, status, ...getModelDetails(chainState.wasmVM, id) };
  });

  return res.json({ count: models.length, address, models });
});

// GET /api/models/:id — single model status + details
router.get("/models/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const address = getModelRegistryAddress();
  if (!address) return res.status(503).json({ error: "ModelRegistry not deployed" });

  const status = await getModelStatus(chainState.wasmVM, id);
  if (status === "unknown") return res.status(404).json({ error: "Model not found" });
  return res.json({ id, status, ...getModelDetails(chainState.wasmVM, id) });
});

// POST /api/models/propose
// Body: { caller, claimedResidual, supportHashHex, inputDim, hiddenDim, lambda, seed, uri }
router.post("/models/propose", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;
  const { claimedResidual, supportHashHex, inputDim, hiddenDim, lambda, seed, uri } = req.body ?? {};
  if (
    typeof claimedResidual !== "number" ||
    typeof supportHashHex !== "string" ||
    typeof inputDim !== "number" ||
    typeof hiddenDim !== "number" ||
    typeof lambda !== "number" ||
    typeof seed !== "number" ||
    typeof uri !== "string"
  ) {
    return res.status(400).json({ error: "claimedResidual, supportHashHex, inputDim, hiddenDim, lambda, seed, uri are required" });
  }

  const result = await proposeModel(chainState.wasmVM, caller, { claimedResidual, supportHashHex, inputDim, hiddenDim, lambda, seed, uri });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/models/:id/verify
// Body: { caller } — permissionless finalize call once the challenge window has elapsed.
router.post("/models/:id/verify", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  const result = await verifyModel(chainState.wasmVM, caller, id);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/models/:id/challenge
// Body: { caller, supportData, supportLabels, tol?, maxIter? }
router.post("/models/:id/challenge", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { supportData, supportLabels, tol, maxIter } = req.body ?? {};
  if (!Array.isArray(supportData) || !Array.isArray(supportLabels)) {
    return res.status(400).json({ error: "supportData and supportLabels arrays are required" });
  }

  const result = await challengeModel(chainState.wasmVM, caller, { modelId: id, supportData, supportLabels, tol, maxIter });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

export default router;
