import { Router } from "express";
import { chainState } from "../chain/index.js";
import { hash256 } from "../chain/crypto.js";
import {
  getMultisigAddress,
  getMultisigInfo,
  proposeAdminAction,
  approveAdminAction,
  isAdminActionApproved,
} from "../chain/multisig.js";

const router = Router();

router.get("/validators", (_req, res) => {
  const validators = [...chainState.validators.values()].map(v => ({
    ...v,
    sharePercent: chainState.totalBondedStake > 0
      ? (v.bondedStake / chainState.totalBondedStake) * 100
      : 0,
  }));
  res.json({
    count: validators.length,
    totalBondedStake: chainState.totalBondedStake,
    validators,
  });
});

router.get("/validators/:addr", (req, res) => {
  const v = chainState.validators.get(req.params["addr"]!);
  if (!v) {
    res.status(404).json({ error: "Validator not found" });
    return;
  }
  const slashHistory = chainState.slashEvents.filter(e => e.validatorAddress === v.address);
  res.json({
    ...v,
    sharePercent: chainState.totalBondedStake > 0
      ? (v.bondedStake / chainState.totalBondedStake) * 100
      : 0,
    slashHistory,
  });
});

router.post("/validators/:addr/slash", async (req, res) => {
  const addr = req.params["addr"]!;
  const { reason, proposalId } = req.body as {
    reason?: "double_sign" | "downtime" | "invalid_block";
    proposalId?: number;
  };
  if (!reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }

  // Admin multisig, when configured, is the sole authorization path — an
  // on-chain threshold of owner signatures replaces the single ADMIN_KEY
  // secret. Falls back to ADMIN_KEY only when no multisig is configured
  // (dev/test convenience).
  if (getMultisigAddress()) {
    if (proposalId === undefined || !Number.isInteger(proposalId)) {
      res.status(400).json({ error: "proposalId is required when admin multisig is configured" });
      return;
    }
    const approved = await isAdminActionApproved(chainState.wasmVM, proposalId);
    if (!approved) {
      res.status(403).json({ error: "Forbidden: proposal has not met the multisig approval threshold" });
      return;
    }
  } else {
    // Accept either ADMIN_KEY (legacy name) or ADMIN_API_KEY (current Replit
    // secret name) so deployments aren't coupled to one specific secret name.
    // Fails CLOSED: if no key is configured in production the request is
    // rejected (misconfigured deployment should never be open by default).
    const adminKey = process.env["ADMIN_KEY"] || process.env["ADMIN_API_KEY"];
    if (!adminKey) {
      if (process.env["NODE_ENV"] === "production") {
        res.status(503).json({ error: "Server misconfiguration: neither ADMIN_KEY nor ADMIN_API_KEY is set" });
        return;
      }
      // Dev convenience: no key configured → pass through with a log warning.
    } else {
      const provided = req.headers["x-admin-key"];
      if (provided !== adminKey) {
        res.status(403).json({ error: "Forbidden: valid X-Admin-Key header required" });
        return;
      }
    }
  }

  const v = chainState.validators.get(addr);
  if (!v) {
    res.status(404).json({ error: "Validator not found" });
    return;
  }
  chainState.slashValidator(addr, reason, chainState.height, Math.floor(Date.now() / 1000));
  res.json({ success: true, validator: chainState.validators.get(addr) });
});

// ── Admin multisig ──────────────────────────────────────────────────────────
// On-chain threshold-signed approval gate for privileged admin actions
// (e.g. the slash route above). See chain/multisig.ts and contracts/multisig.wat.

router.get("/admin/multisig", (_req, res) => {
  res.json(getMultisigInfo(chainState.wasmVM));
});

router.post("/admin/multisig/propose", async (_req, res) => {
  if (!getMultisigAddress()) {
    res.status(400).json({ error: "Admin multisig is not configured" });
    return;
  }
  const result = await proposeAdminAction(chainState.wasmVM);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json({ proposalId: result.proposalId });
});

router.post("/admin/multisig/:proposalId/approve", async (req, res) => {
  if (!getMultisigAddress()) {
    res.status(400).json({ error: "Admin multisig is not configured" });
    return;
  }
  const proposalId = Number(req.params["proposalId"]);
  const { ownerIndex, pubkey, signature } = req.body as {
    ownerIndex?: number;
    pubkey?: string;
    signature?: string;
  };
  if (!Number.isInteger(proposalId) || ownerIndex === undefined || !pubkey || !signature) {
    res.status(400).json({ error: "ownerIndex, pubkey (64 hex chars), and signature (128 hex chars) are required" });
    return;
  }
  const result = await approveAdminAction(chainState.wasmVM, proposalId, ownerIndex, pubkey, signature);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ approved: result.approved, thresholdMet: result.thresholdMet });
});

router.get("/admin/multisig/:proposalId", async (req, res) => {
  if (!getMultisigAddress()) {
    res.status(400).json({ error: "Admin multisig is not configured" });
    return;
  }
  const proposalId = Number(req.params["proposalId"]);
  if (!Number.isInteger(proposalId)) {
    res.status(400).json({ error: "Invalid proposalId" });
    return;
  }
  const approved = await isAdminActionApproved(chainState.wasmVM, proposalId);
  res.json({ proposalId, approved });
});

router.get("/validators/:addr/slash-history", (req, res) => {
  const addr = req.params["addr"]!;
  const events = chainState.slashEvents.filter(e => e.validatorAddress === addr);
  res.json({ validatorAddress: addr, events });
});

// ── Fee earnings history ────────────────────────────────────────────────────
//
// GET /api/validators/:addr/fees
//
// Aggregates the per-block fee breakdown (see GET /api/blocks/:id/fees) across
// every block this validator has mined, so the Explorer can show total fee
// income separate from block rewards, plus a per-block time series for a
// chart. Fee income = account-model tx fees + swept UTXO-model tx fees.
router.get("/validators/:addr/fees", (req, res) => {
  const addr = req.params["addr"]!;
  const v = chainState.validators.get(addr);
  if (!v) {
    res.status(404).json({ error: "Validator not found" });
    return;
  }

  const minedBlocks = chainState.blocks.filter(b => b.miner === addr);

  let totalCoinbaseRewards = 0;
  let totalAccountFees = 0;
  let totalUtxoFees = 0;

  const history = minedBlocks.map(block => {
    const accountFeeTxs = block.transactions.filter(tx => tx.fee > 0);
    const accountFeesTotal = accountFeeTxs.reduce((sum, tx) => sum + tx.fee, 0);

    const utxoFeeTxHash = hash256(`utxo-fees-${block.height}-${block.hash}`);
    const utxoFeeUtxo = chainState.utxoSet.get(utxoFeeTxHash, 0);
    const utxoFeesTotal = utxoFeeUtxo?.amount ?? 0;

    totalCoinbaseRewards += block.coinbaseReward;
    totalAccountFees += accountFeesTotal;
    totalUtxoFees += utxoFeesTotal;

    return {
      height: block.height,
      hash: block.hash,
      timestamp: block.timestamp,
      coinbaseReward: block.coinbaseReward,
      accountFees: accountFeesTotal,
      utxoFees: utxoFeesTotal,
      totalFees: accountFeesTotal + utxoFeesTotal,
    };
  }).sort((a, b) => a.height - b.height);

  const totalFees = totalAccountFees + totalUtxoFees;

  res.json({
    validatorAddress: addr,
    blocksMined: minedBlocks.length,
    totalCoinbaseRewards,
    totalAccountFees,
    totalUtxoFees,
    totalFees,
    totalEarnings: totalCoinbaseRewards + totalFees,
    avgFeePerBlock: minedBlocks.length > 0 ? totalFees / minedBlocks.length : 0,
    history,
  });
});

router.get("/validators/:addr/delegators", (req, res) => {
  const addr = req.params["addr"]!;
  const v = chainState.validators.get(addr);
  if (!v) {
    res.status(404).json({ error: "Validator not found" });
    return;
  }
  const delegators = chainState.getDelegators(addr);
  res.json({
    validatorAddress: addr,
    count: delegators.length,
    totalDelegated: delegators.reduce((s, d) => s + d.stakedAmount, 0),
    delegators,
  });
});

export default router;
