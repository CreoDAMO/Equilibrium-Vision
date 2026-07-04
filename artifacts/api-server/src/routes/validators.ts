import { Router } from "express";
import { chainState } from "../chain/index.js";

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

router.post("/validators/:addr/slash", (req, res) => {
  const addr = req.params["addr"]!;
  const { reason } = req.body as { reason?: "double_sign" | "downtime" | "invalid_block" };
  if (!reason) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  const v = chainState.validators.get(addr);
  if (!v) {
    res.status(404).json({ error: "Validator not found" });
    return;
  }
  chainState.slashValidator(addr, reason, chainState.height, Math.floor(Date.now() / 1000));
  res.json({ success: true, validator: chainState.validators.get(addr) });
});

router.get("/validators/:addr/slash-history", (req, res) => {
  const addr = req.params["addr"]!;
  const events = chainState.slashEvents.filter(e => e.validatorAddress === addr);
  res.json({ validatorAddress: addr, events });
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
