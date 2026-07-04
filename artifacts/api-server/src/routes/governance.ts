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
 * Verify an Ed25519 vote signature using Node.js built-in crypto.
 * Canonical message: UTF-8("vote:{proposalId}:{choice}")
 *
 * Ed25519 raw public keys (32 bytes) must be wrapped in a SubjectPublicKeyInfo
 * DER envelope before Node.js can consume them as a KeyObject.
 * DER prefix for Ed25519 SPKI: 302a300506032b6570032100
 *
 * Returns false on any parse or crypto error.
 */
function verifyVoteSignature(
  publicKeyHex: string,
  signatureHex: string,
  proposalId: string,
  choice: string,
): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyHex, "hex");
    const sig       = Buffer.from(signatureHex, "hex");
    const msg       = Buffer.from(`vote:${proposalId}:${choice}`, "utf8");

    // Wrap raw 32-byte Ed25519 key in SPKI DER envelope
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer    = Buffer.concat([spkiPrefix, rawPubKey]);
    const keyObject  = createPublicKey({ key: spkiDer, format: "der", type: "spki" });

    return cryptoVerify(null, msg, keyObject, sig);
  } catch {
    return false;
  }
}

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

  // ── Signature verification ─────────────────────────────────────────────────
  // 1. Ensure the supplied public key actually maps to the claimed voter address.
  let derivedAddr: string;
  try {
    derivedAddr = addressFromPublicKey(publicKey);
  } catch {
    res.status(400).json({ error: "publicKey is not valid hex" });
    return;
  }
  if (derivedAddr !== voter) {
    res.status(403).json({ error: "publicKey does not correspond to voter address" });
    return;
  }

  // 2. Verify the signature over the canonical vote message.
  const proposalId = req.params["id"]!;
  if (!verifyVoteSignature(publicKey, signature, proposalId, choice)) {
    res.status(403).json({ error: "Invalid vote signature — sign vote:{proposalId}:{choice} with your Ed25519 key" });
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

  // Voting power = bonded stake only (validators + their delegated stake).
  // Ledger account balance is excluded so quorum math (denominator =
  // totalBondedStake) remains coherent.
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
