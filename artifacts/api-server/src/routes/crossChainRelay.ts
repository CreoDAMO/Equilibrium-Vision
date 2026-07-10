/**
 * CrossChainRelay REST routes.
 *
 * Federated cross-chain attestation protocol — m-of-n bonded relayers sign
 * inbound state commitments from foreign chains. No IBC light client required.
 *
 * Route overview:
 *   POST   /api/relay/register                           — Relayer self-registration (bonds EQU)
 *   DELETE /api/relay/register/:addr                     — Admin: revoke relayer + return bond
 *   PATCH  /api/relay/threshold                          — Admin: set m-of-n threshold
 *   POST   /api/relay/attest/inbound                     — Submit m-of-n signed attestation
 *   POST   /api/relay/attest/inbound/:chainId/:seq/challenge  — Admin: slash fraudulent signers
 *   POST   /api/relay/attest/inbound/:chainId/:seq/finalize   — Anyone: finalize after window
 *   POST   /api/relay/outbound/:chainId                  — Publish outbound commitment
 *   GET    /api/relay/attest/inbound/:chainId/:seq        — Attestation status + details
 *   GET    /api/relay/outbound/:chainId/seq               — Current outbound sequence
 *   GET    /api/relay/info                                — Threshold, relayer count, address
 */
import { Router } from "express";
import { chainState } from "../chain/index.js";
import {
  getCrossChainRelayAddress,
  registerRelayer,
  revokeRelayer,
  setThreshold,
  submitInboundAttestation,
  challengeInbound,
  finalizeInbound,
  publishOutbound,
  getInboundStatus,
  getOutboundSeq,
  getRelayThreshold,
  getRelayerCount,
  getRelayDetails,
  buildAttestationMessage,
} from "../chain/crossChainRelay.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── admin auth (same pattern as validators slash route) ──────────────────────

function requireAdmin(req: import("express").Request, res: import("express").Response): boolean {
  const adminKey = process.env["ADMIN_KEY"] ?? process.env["ADMIN_API_KEY"] ?? "";
  const provided = req.headers["x-admin-key"] ?? req.body?.adminKey ?? "";
  if (!adminKey || provided !== adminKey) {
    res.status(403).json({ error: "Admin authentication required" });
    return false;
  }
  return true;
}

function requireCaller(req: import("express").Request, res: import("express").Response): string | null {
  const caller = typeof req.body?.caller === "string" ? req.body.caller.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(caller)) {
    res.status(400).json({ error: "caller (40-hex-char address) is required" });
    return null;
  }
  return caller;
}

function parseSeq(raw: string): bigint | null {
  try {
    const n = BigInt(raw);
    if (n < 0n) return null;
    return n;
  } catch {
    return null;
  }
}

// ── POST /api/relay/register ─────────────────────────────────────────────────
// Relayer self-registration: caller bonds `amount` EQU and joins the set.
// The bond is escrowed inside the contract (host `bond()` import).

router.post("/relay/register", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  let amount: bigint;
  try {
    amount = BigInt(req.body?.amount ?? 0);
    if (amount <= 0n) throw new Error("amount must be > 0");
  } catch (e) {
    res.status(400).json({ error: `Invalid amount: ${(e as Error).message}` });
    return;
  }

  const result = await registerRelayer(chainState.wasmVM, caller, amount);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  logger.info({ caller, amount: amount.toString() }, "Relayer registered");
  res.json({ success: true, caller, amount: amount.toString() });
});

// ── DELETE /api/relay/register/:addr ─────────────────────────────────────────
// Admin: revoke a relayer (returns bond).

router.delete("/relay/register/:addr", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const addr = req.params["addr"]?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(addr)) {
    res.status(400).json({ error: "addr must be a 40-hex-char address" });
    return;
  }
  const adminAddr = req.body?.caller ?? addr;
  const result = await revokeRelayer(chainState.wasmVM, adminAddr, addr);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  logger.info({ addr }, "Relayer revoked by admin");
  res.json({ success: true, revoked: addr });
});

// ── PATCH /api/relay/threshold ───────────────────────────────────────────────
// Admin: update m-of-n threshold.

router.patch("/relay/threshold", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const m = parseInt(String(req.body?.threshold ?? ""), 10);
  if (!Number.isFinite(m) || m <= 0) {
    res.status(400).json({ error: "threshold must be a positive integer" });
    return;
  }
  const caller = req.body?.caller ?? "";
  const result = await setThreshold(chainState.wasmVM, caller, m);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ success: true, threshold: m });
});

// ── POST /api/relay/attest/inbound ───────────────────────────────────────────
// Submit an m-of-n signed inbound attestation (permissionless).
// The contract verifies every signature; only relayers can sign.
//
// Body: {
//   caller: string,        40-hex-char address of the submitter
//   chainId: string,       source chain identifier (e.g. "cosmoshub-4")
//   seq: string | number,  attestation sequence (must be exactly lastSeq+1)
//   commitmentHex: string, 64 hex chars — 32-byte foreign state commitment
//   signatures: [{
//     signatureHex: string,  128 hex chars — Ed25519 sig over the attestation msg
//     pubkeyHex: string,     64 hex chars  — raw Ed25519 public key
//     signerAddress: string, 40 hex chars  — sha256(pubkeyBytes)[..20]
//   }]
// }

router.post("/relay/attest/inbound", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;

  const { chainId, seq: seqRaw, commitmentHex, signatures } = req.body ?? {};
  if (typeof chainId !== "string" || !chainId.trim()) {
    res.status(400).json({ error: "chainId is required" });
    return;
  }
  const seq = parseSeq(String(seqRaw ?? ""));
  if (seq === null) {
    res.status(400).json({ error: "seq must be a non-negative integer or BigInt string" });
    return;
  }
  if (!Array.isArray(signatures) || signatures.length === 0) {
    res.status(400).json({ error: "signatures must be a non-empty array" });
    return;
  }

  // Expose the canonical message so callers can pre-verify
  const expectedMsg = buildAttestationMessage(chainId, seq, commitmentHex ?? "");

  const result = await submitInboundAttestation(chainState.wasmVM, caller, {
    chainId,
    seq,
    commitmentHex,
    signatures,
  });

  if (!result.success) {
    res.status(400).json({ error: result.error, expectedMessage: expectedMsg });
    return;
  }
  logger.info({ chainId, seq: seq.toString() }, "Inbound attestation accepted");
  res.json({ success: true, chainId, seq: seq.toString(), commitmentHex });
});

// ── POST /api/relay/attest/inbound/:chainId/:seq/challenge ───────────────────
// Admin: flag an attestation as fraudulent and slash all signers.

router.post("/relay/attest/inbound/:chainId/:seq/challenge", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const chainId = req.params["chainId"] ?? "";
  const seq = parseSeq(req.params["seq"] ?? "");
  if (!chainId || seq === null) {
    res.status(400).json({ error: "Invalid chainId or seq" });
    return;
  }
  const caller = req.body?.caller ?? "";
  const result = await challengeInbound(chainState.wasmVM, caller, chainId, seq);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  logger.warn({ chainId, seq: seq.toString() }, "Inbound attestation challenged — signers slashed");
  res.json({ success: true, chainId, seq: seq.toString(), challenged: true });
});

// ── POST /api/relay/attest/inbound/:chainId/:seq/finalize ────────────────────
// Anyone can finalize an unchallenged attestation after the challenge window.

router.post("/relay/attest/inbound/:chainId/:seq/finalize", async (req, res) => {
  const chainId = req.params["chainId"] ?? "";
  const seq = parseSeq(req.params["seq"] ?? "");
  if (!chainId || seq === null) {
    res.status(400).json({ error: "Invalid chainId or seq" });
    return;
  }
  const caller = req.body?.caller ?? "";
  const result = await finalizeInbound(chainState.wasmVM, caller, chainId, seq);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  logger.info({ chainId, seq: seq.toString() }, "Inbound attestation finalized");
  res.json({ success: true, chainId, seq: seq.toString(), finalized: true });
});

// ── POST /api/relay/outbound/:chainId ────────────────────────────────────────
// Publish an outbound state commitment (for foreign chains to verify).
// Caller must be a registered relayer.

router.post("/relay/outbound/:chainId", async (req, res) => {
  const caller = requireCaller(req, res);
  if (!caller) return;
  const chainId = req.params["chainId"] ?? "";
  if (!chainId) {
    res.status(400).json({ error: "chainId is required" });
    return;
  }
  const { commitmentHex } = req.body ?? {};
  if (typeof commitmentHex !== "string" || !/^[0-9a-f]{64}$/.test(commitmentHex)) {
    res.status(400).json({ error: "commitmentHex must be 64 hex chars (32 bytes)" });
    return;
  }
  const result = await publishOutbound(chainState.wasmVM, caller, chainId, commitmentHex);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ success: true, chainId, outboundSeq: result.outboundSeq, commitmentHex });
});

// ── GET /api/relay/attest/inbound/:chainId/:seq ──────────────────────────────

router.get("/relay/attest/inbound/:chainId/:seq", async (req, res) => {
  const chainId = req.params["chainId"] ?? "";
  const seq = parseSeq(req.params["seq"] ?? "");
  if (!chainId || seq === null) {
    res.status(400).json({ error: "Invalid chainId or seq" });
    return;
  }
  const relayAddr = getCrossChainRelayAddress();
  if (!relayAddr) {
    res.status(503).json({ error: "CrossChainRelay not deployed" });
    return;
  }
  const status = await getInboundStatus(chainState.wasmVM, chainId, seq);
  if (status === "not_found") {
    res.status(404).json({ error: "Attestation not found" });
    return;
  }
  const storage = chainState.wasmVM.getStorage(relayAddr);
  const prefix = `att:${chainId}:${seq}`;
  const commitment = storage[`${prefix}:commitment`] ?? null;
  const signers = (storage[`${prefix}:signers`] ?? "").split(",").filter(Boolean);
  const block = storage[`${prefix}:block`] ? parseInt(storage[`${prefix}:block`]!, 10) : null;
  res.json({ chainId, seq: seq.toString(), status, commitment, signers, block });
});

// ── GET /api/relay/outbound/:chainId/seq ─────────────────────────────────────

router.get("/relay/outbound/:chainId/seq", async (req, res) => {
  const chainId = req.params["chainId"] ?? "";
  if (!chainId) {
    res.status(400).json({ error: "chainId is required" });
    return;
  }
  const outboundSeq = await getOutboundSeq(chainState.wasmVM, chainId);
  res.json({ chainId, outboundSeq });
});

// ── GET /api/relay/info ───────────────────────────────────────────────────────

router.get("/relay/info", async (_req, res) => {
  const address = getCrossChainRelayAddress();
  if (!address) {
    res.status(503).json({ error: "CrossChainRelay not deployed" });
    return;
  }
  const [threshold, relayerCount] = await Promise.all([
    getRelayThreshold(chainState.wasmVM),
    getRelayerCount(chainState.wasmVM),
  ]);
  const { relayers } = getRelayDetails(chainState.wasmVM);
  res.json({ address, threshold, relayerCount, relayers });
});

export default router;
