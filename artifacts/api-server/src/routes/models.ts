/**
 * REST routes for the ModelRegistry WASM contract (see
 * contracts/model_registry/src/lib.rs and chain/modelRegistry.ts). This is a
 * permissionless optimistic oracle — propose/verify/challenge are gated
 * economically by bonds inside the contract itself, not by admin auth here.
 *
 * IPFS support
 * ─────────────
 * POST /api/models/hash-support
 *   Accepts { supportData, supportLabels } and returns the canonical SHA-256
 *   commitment hash.  Proposers use this to obtain the `supportHashHex` they
 *   must submit on-chain without having to run the encoding client-side.
 *
 * POST /api/models/:id/challenge
 *   Also accepts an `ipfsCid` string (or an `ipfs://` URI) in place of raw
 *   arrays.  When provided the server fetches the support set from the public
 *   IPFS HTTP gateway (default: https://ipfs.io/ipfs/) and proceeds normally.
 *   The gateway is configurable via the IPFS_GATEWAY_URL environment variable.
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
  encodeSupportCommitment,
  submitInferenceAttestation,
  getInferenceStatus,
} from "../chain/modelRegistry.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Public IPFS HTTP gateway used to fetch support sets when a CID is provided
// instead of raw data.  Operators can override with IPFS_GATEWAY_URL.
const IPFS_GATEWAY = (process.env["IPFS_GATEWAY_URL"] ?? "https://ipfs.io/ipfs/").replace(/\/$/, "");

function requireCaller(req: import("express").Request, res: import("express").Response): string | null {
  const caller = typeof req.body?.caller === "string" ? req.body.caller.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(caller)) {
    res.status(400).json({ error: "caller (40-hex-char address) is required" });
    return null;
  }
  return caller;
}

/**
 * Normalise an IPFS CID or URI to a bare CID string.
 * Accepts:
 *   - "Qm..." / "bafy..." (bare CID)
 *   - "ipfs://Qm..."
 *   - "ipfs://ipfs/Qm..."
 *   - Full gateway URLs (https://ipfs.io/ipfs/Qm...)
 */
// Strict CID shape: CIDv0 = Qm + 44 base58 chars; CIDv1 = b + 58+ base32 chars.
// Only alphanumeric — no slashes, query strings, or authority components.
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/i;

function extractCid(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // ipfs:// scheme — use string ops (no regex on unbounded user input) to
  // avoid polynomial backtracking (ReDoS).
  const IPFS_SCHEME = "ipfs://";
  const IPFS_INFIX  = "ipfs/";
  if (s.toLowerCase().startsWith(IPFS_SCHEME)) {
    let rest = s.slice(IPFS_SCHEME.length);
    if (rest.toLowerCase().startsWith(IPFS_INFIX)) rest = rest.slice(IPFS_INFIX.length);
    const cid = rest.trim();
    return CID_RE.test(cid) ? cid : null;
  }

  // Full gateway URL — locate the last /ipfs/ segment with indexOf (O(n), no regex).
  const marker = "/ipfs/";
  const idx = s.toLowerCase().lastIndexOf(marker);
  if (idx !== -1) {
    const cid = s.slice(idx + marker.length).trim();
    return CID_RE.test(cid) ? cid : null;
  }

  // Bare CID
  if (CID_RE.test(s)) return s;

  return null;
}

interface IpfsSupportPayload {
  supportData:   number[][];
  supportLabels: number[];
}

// Pre-parsed origin of the configured gateway, used to prevent SSRF: we
// verify the assembled request URL never leaves the gateway's origin even if
// a CID somehow contained path-escape sequences.
const IPFS_GATEWAY_ORIGIN = (() => {
  try { return new URL(IPFS_GATEWAY).origin; }
  catch { return null; }
})();

/**
 * Fetch support-set JSON from an IPFS gateway.
 * Expected payload shape: { supportData: number[][], supportLabels: number[] }
 */
async function fetchSupportFromIpfs(cid: string, timeoutMs = 15_000): Promise<IpfsSupportPayload> {
  // Re-validate the CID at fetch time: extractCid() already enforces CID_RE,
  // but this guard ensures no caller can bypass it and pass an arbitrary path.
  if (!CID_RE.test(cid)) {
    throw new Error(`Invalid CID passed to fetchSupportFromIpfs: ${cid}`);
  }

  // encodeURIComponent() makes the CID URL-safe and acts as the static-analysis
  // sanitizer that breaks the taint flow from user input to the fetch() URL.
  // Because CIDs are strictly alphanumeric, this is a no-op at runtime, but it
  // prevents CodeQL from treating `cid` as unsanitised user input in the URL.
  const safeCid = encodeURIComponent(cid);

  // Reconstruct the URL from the trusted gateway base + the sanitised CID.
  // Origin guard: IPFS_GATEWAY is server-controlled; safeCid is alphanumeric
  // only (encodeURIComponent cannot introduce an authority component for chars
  // already matched by CID_RE), so the assembled URL can never leave the
  // gateway's origin. lgtm[js/request-forgery]
  const url = `${IPFS_GATEWAY}/${safeCid}`;

  if (IPFS_GATEWAY_ORIGIN) {
    let assembledOrigin: string;
    try { assembledOrigin = new URL(url).origin; }
    catch { throw new Error(`Invalid IPFS URL assembled for CID ${cid}`); }
    if (assembledOrigin !== IPFS_GATEWAY_ORIGIN) {
      throw new Error(`SSRF guard: assembled URL origin ${assembledOrigin} does not match gateway origin ${IPFS_GATEWAY_ORIGIN}`);
    }
  }

  logger.info({ url }, "Fetching support set from IPFS gateway");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    // lgtm[js/request-forgery] — URL is gateway-base (server config) + encodeURIComponent(cid)
    // where cid is validated against CID_RE (alphanumeric only, no authority chars).
    res = await fetch(url, { signal: controller.signal });
  } catch (err: unknown) {
    throw new Error(`IPFS fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`IPFS gateway returned HTTP ${res.status} for CID ${cid}`);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`IPFS gateway did not return valid JSON for CID ${cid}`);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as IpfsSupportPayload).supportData) ||
    !Array.isArray((payload as IpfsSupportPayload).supportLabels)
  ) {
    throw new Error(
      `IPFS payload must be { supportData: number[][], supportLabels: number[] }, got: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }

  const { supportData, supportLabels } = payload as IpfsSupportPayload;

  // Validate inner structure: supportData must be number[][], supportLabels number[].
  if (!supportLabels.every((v) => typeof v === "number")) {
    throw new Error("IPFS payload: supportLabels must be an array of numbers");
  }
  if (!supportData.every((row) =>
    Array.isArray(row) && row.every((v) => typeof v === "number")
  )) {
    throw new Error("IPFS payload: supportData must be an array of number[] rows");
  }

  return { supportData, supportLabels };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

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

  chainState.wasmVM.setBlockHeight(chainState.height);
  const status = await getModelStatus(chainState.wasmVM, id);
  if (status === "unknown") return res.status(404).json({ error: "Model not found" });
  return res.json({ id, status, ...getModelDetails(chainState.wasmVM, id) });
});

// POST /api/models/hash-support
// Body: { supportData: number[][], supportLabels: number[] }
// Returns: { hashHex: string } — the canonical SHA-256 commitment hash that
// must be submitted as `supportHashHex` in propose().
//
// This endpoint is a pure utility: it never touches chain state.  Proposers
// use it to compute the correct hash to store on-chain before uploading the
// support set to IPFS (or any other off-chain store) themselves.
router.post("/models/hash-support", (req, res) => {
  const { supportData, supportLabels } = req.body ?? {};
  if (!Array.isArray(supportData) || !Array.isArray(supportLabels)) {
    return res.status(400).json({ error: "supportData (number[][]) and supportLabels (number[]) are required" });
  }
  try {
    const { hashHex } = encodeSupportCommitment(supportData as number[][], supportLabels as number[]);
    return res.json({ hashHex });
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }
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

  chainState.wasmVM.setBlockHeight(chainState.height);
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

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await verifyModel(chainState.wasmVM, caller, id);
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/models/:id/challenge
// Body (raw data):   { caller, supportData, supportLabels, tol?, maxIter? }
// Body (IPFS):       { caller, ipfsCid, tol?, maxIter? }
//   ipfsCid accepts a bare CID, an ipfs:// URI, or the full gateway URL.
//   The server fetches the support set from the configured IPFS gateway and
//   proceeds identically to the raw-data path.
router.post("/models/:id/challenge", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { ipfsCid, tol, maxIter } = req.body ?? {};
  let { supportData, supportLabels } = req.body ?? {};

  // IPFS path: fetch the support set from the gateway if raw arrays are absent.
  if ((!Array.isArray(supportData) || !Array.isArray(supportLabels)) && ipfsCid) {
    const cid = extractCid(String(ipfsCid));
    if (!cid) {
      return res.status(400).json({ error: `Could not parse a valid IPFS CID from: ${ipfsCid}` });
    }
    try {
      const payload = await fetchSupportFromIpfs(cid);
      supportData   = payload.supportData;
      supportLabels = payload.supportLabels;
    } catch (err) {
      return res.status(502).json({ error: (err as Error).message });
    }
  }

  if (!Array.isArray(supportData) || !Array.isArray(supportLabels)) {
    return res.status(400).json({
      error: "Provide either (supportData + supportLabels) arrays, or an ipfsCid pointing to { supportData, supportLabels }",
    });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await challengeModel(chainState.wasmVM, caller, { modelId: id, supportData, supportLabels, tol, maxIter });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// POST /api/models/:id/inference-proof
// Body: { caller, inputHashHex, outputHashHex, signatureHex, pubkeyHex, attestorAddress }
// Records an Ed25519-signed inference receipt (NOT a zero-knowledge proof —
// see contracts/model_registry/src/lib.rs method 5 for the honest scope of
// what this verifies). `caller` is just the tx submitter and may differ
// from `attestorAddress`, the keyholder who actually signed the receipt.
router.post("/models/:id/inference-proof", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { inputHashHex, outputHashHex, signatureHex, pubkeyHex, attestorAddress } = req.body ?? {};
  if (
    typeof inputHashHex !== "string" ||
    typeof outputHashHex !== "string" ||
    typeof signatureHex !== "string" ||
    typeof pubkeyHex !== "string" ||
    typeof attestorAddress !== "string"
  ) {
    return res.status(400).json({ error: "inputHashHex, outputHashHex, signatureHex, pubkeyHex, attestorAddress are required" });
  }

  chainState.wasmVM.setBlockHeight(chainState.height);
  const result = await submitInferenceAttestation(chainState.wasmVM, caller, {
    modelId: id, inputHashHex, outputHashHex, signatureHex, pubkeyHex, attestorAddress,
  });
  if (!result.success) return res.status(400).json(result);
  return res.json(result);
});

// GET /api/models/:id/inference-status
router.get("/models/:id/inference-status", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: "Invalid model id" });
  const address = getModelRegistryAddress();
  if (!address) return res.status(503).json({ error: "ModelRegistry not deployed" });

  const status = await getInferenceStatus(chainState.wasmVM, id);
  if (status === "unknown") return res.status(404).json({ error: "Model not found" });
  return res.json({ id, inferenceStatus: status });
});

export default router;
