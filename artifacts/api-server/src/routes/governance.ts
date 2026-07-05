import { Router } from "express";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { chainState } from "../chain/index.js";

const router = Router();

/**
 * Derive the canonical Equilibrium address from a raw Ed25519 public key.
 * Algorithm: SHA-256(raw_pubkey_bytes)[0..20] as 40 lowercase hex chars.
 * Must match the wallet (explorer/src/wallet/crypto.ts) and Rust address_from_pubkey.
 */
function addressFromPublicKey(publicKeyHex: string): string {
  const bytes = Buffer.from(publicKeyHex, "hex");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 40);
}

/**
 * Verify an Ed25519 signature using Node.js built-in crypto.
 * Ed25519 raw public keys (32 bytes) must be wrapped in a SubjectPublicKeyInfo
 * DER envelope before Node.js can consume them as a KeyObject.
 * DER prefix for Ed25519 SPKI: 302a300506032b6570032100
 *
 * Returns false on any parse or crypto error.
 */
function verifyEd25519(publicKeyHex: string, signatureHex: string, message: Buffer): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyHex, "hex");
    const sig       = Buffer.from(signatureHex, "hex");

    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer    = Buffer.concat([spkiPrefix, rawPubKey]);
    const keyObject  = createPublicKey({ key: spkiDer, format: "der", type: "spki" });

    return cryptoVerify(null, message, keyObject, sig);
  } catch {
    return false;
  }
}

/**
 * Verify an Ed25519 vote signature.
 * Canonical message: UTF-8("vote:{proposalId}:{choice}")
 */
function verifyVoteSignature(
  publicKeyHex: string,
  signatureHex: string,
  proposalId: string,
  choice: string,
): boolean {
  return verifyEd25519(
    publicKeyHex,
    signatureHex,
    Buffer.from(`vote:${proposalId}:${choice}`, "utf8"),
  );
}

/**
 * Verify an Ed25519 proposal signature.
 * Canonical message: UTF-8("proposal:{type}:{title}:{description}")
 */
function verifyProposalSignature(
  publicKeyHex: string,
  signatureHex: string,
  type: string,
  title: string,
  description: string,
): boolean {
  return verifyEd25519(
    publicKeyHex,
    signatureHex,
    Buffer.from(`proposal:${type}:${title}:${description}`, "utf8"),
  );
}

// GET /governance/proposals — list all proposals with live vote tallies
router.get("/governance/proposals", (_req, res) => {
  const summaries = chainState.governance.getSummaries(chainState.totalBondedStake);
  res.json({ count: summaries.length, proposals: summaries });
});

const HEX_ADDR_RE = /^[0-9a-f]{40}$/;

// POST /governance/proposals — submit a new proposal
// Requires signature + publicKey fields so the proposer proves ownership of the address.
// Canonical message: UTF-8("proposal:{type}:{title}:{description}")
router.post("/governance/proposals", (req, res) => {
  const { proposer, type, title, description, parameterChange, signature, publicKey } = req.body as {
    proposer?: string;
    type?: string;
    title?: string;
    description?: string;
    parameterChange?: { key: string; value: number };
    signature?: string;
    publicKey?: string;
  };

  if (!proposer || !type || !title || !description) {
    res.status(400).json({ error: "proposer, type, title, and description are required" });
    return;
  }
  if (!HEX_ADDR_RE.test(proposer)) {
    res.status(400).json({ error: "Invalid proposer address: must be 40 lowercase hex chars" });
    return;
  }
  if (type !== "text" && type !== "parameter_change") {
    res.status(400).json({ error: "type must be 'text' or 'parameter_change'" });
    return;
  }

  if (!signature || !publicKey) {
    res.status(400).json({ error: "signature and publicKey are required to prove proposer identity" });
    return;
  }

  const derivedAddress = addressFromPublicKey(publicKey);
  if (derivedAddress !== proposer) {
    res.status(401).json({ error: "publicKey does not match proposer address" });
    return;
  }

  if (!verifyProposalSignature(publicKey, signature, type, title, description)) {
    res.status(401).json({ error: "Invalid proposal signature" });
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
  const { voter, choice, publicKey, signature } = req.body as {
    voter?: string;
    choice?: string;
    publicKey?: string;
    signature?: string;
  };

  if (!voter || !choice || !publicKey || !signature) {
    res.status(400).json({ error: "voter, choice, publicKey, and signature are required" });
    return;
  }
  if (!["yes", "no", "abstain"].includes(choice)) {
    res.status(400).json({ error: "choice must be 'yes', 'no', or 'abstain'" });
    return;
  }

  // ── Input validation ───────────────────────────────────────────────────────
  // Ed25519 public key = 32 bytes = 64 hex chars
  // Ed25519 signature  = 64 bytes = 128 hex chars
  const hexRe = /^[0-9a-f]+$/i;
  if (publicKey.length !== 64 || !hexRe.test(publicKey)) {
    res.status(400).json({ error: "publicKey must be exactly 64 lowercase hex characters (32-byte Ed25519 key)" });
    return;
  }
  if (signature.length !== 128 || !hexRe.test(signature)) {
    res.status(400).json({ error: "signature must be exactly 128 hex characters (64-byte Ed25519 signature)" });
    return;
  }

  // ── Signature verification ─────────────────────────────────────────────────
  // 1. Ensure the supplied public key actually maps to the claimed voter address.
  //    This is a client input-consistency error (the request itself is malformed
  //    — the voter/publicKey pairing is wrong), so it's a 400, not an auth failure.
  const derivedAddr = addressFromPublicKey(publicKey);
  if (derivedAddr !== voter) {
    res.status(400).json({ error: "publicKey does not correspond to voter address" });
    return;
  }

  // 2. Verify the signature over the canonical vote message.
  //    This is an authentication failure — the caller failed to prove ownership
  //    of the voter's private key — so it's a 401, matching standard auth semantics.
  const proposalId = req.params["id"]!;
  if (!verifyVoteSignature(publicKey, signature, proposalId, choice)) {
    res.status(401).json({ error: "Invalid vote signature — sign vote:{proposalId}:{choice} with your Ed25519 key" });
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Voting power — no double-counting ─────────────────────────────────────
  // A validator's bondedStake already includes all delegated amounts (stake()
  // increments v.bondedStake). So to avoid counting the same tokens twice:
  //   • If voter is a validator: vote with self-bond only
  //     (bondedStake − sum of active delegations to this validator).
  //   • If voter is a delegator: vote with their delegated amount only.
  // Total power across all participants = totalBondedStake (no overlap).
  const validatorRecord = chainState.validators.get(voter);
  let votingPower = 0;

  if (validatorRecord) {
    // Compute self-bond = total bonded minus all active delegations
    const delegatedToValidator = [...chainState.stakes.values()]
      .filter(s => s.validator === voter && !s.unbonding)
      .reduce((sum, s) => sum + s.amount, 0);
    votingPower = Math.max(0, validatorRecord.bondedStake - delegatedToValidator);
  } else {
    // Not a validator — use own delegated stake in any validator
    votingPower = [...chainState.stakes.values()]
      .filter(s => s.delegator === voter && !s.unbonding)
      .reduce((acc, s) => acc + s.amount, 0);
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
