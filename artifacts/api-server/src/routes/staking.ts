import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/stake/:address", (req, res) => {
  const addr = req.params["address"]!;
  const positions: Array<typeof chainState.stakes extends Map<string, infer V> ? V : never> = [];
  for (const [key, stake] of chainState.stakes) {
    if (key.startsWith(addr + "-") || stake.delegator === addr) {
      positions.push(stake);
    }
  }
  const unbonding = chainState.unbondingQueue.filter(u => u.delegator === addr);
  const totalStaked = positions.reduce((s, p) => s + p.amount, 0);
  const totalUnbonding = unbonding.reduce((s, u) => s + u.amount, 0);

  res.json({
    delegator: addr,
    totalStaked,
    totalUnbonding,
    positions,
    unbonding,
  });
});

router.post("/stake", (req, res) => {
  const { delegator, validator, amount } = req.body as {
    delegator?: string;
    validator?: string;
    amount?: number;
  };

  if (!delegator || !validator || amount == null) {
    res.status(400).json({ error: "delegator, validator, amount are required" });
    return;
  }
  if (delegator.length !== 40) {
    res.status(400).json({ error: "Invalid delegator address" });
    return;
  }
  if (validator.length !== 40) {
    res.status(400).json({ error: "Invalid validator address" });
    return;
  }
  if (amount <= 0) {
    res.status(400).json({ error: "amount must be positive" });
    return;
  }

  const err = chainState.stake(delegator, validator, amount, chainState.height);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  res.json({
    success: true,
    delegator,
    validator,
    amount,
    effectiveHeight: chainState.height,
  });
});

router.post("/unstake", (req, res) => {
  const { delegator, validator, amount } = req.body as {
    delegator?: string;
    validator?: string;
    amount?: number;
  };

  if (!delegator || !validator || amount == null) {
    res.status(400).json({ error: "delegator, validator, amount are required" });
    return;
  }
  if (amount <= 0) {
    res.status(400).json({ error: "amount must be positive" });
    return;
  }

  const err = chainState.unstake(delegator, validator, amount, chainState.height);
  if (err) {
    res.status(400).json({ error: err });
    return;
  }
  res.json({
    success: true,
    delegator,
    validator,
    amount,
    unbondingPeriod: 10,
    completionHeight: chainState.height + 10,
  });
});

router.get("/staking/summary", (_req, res) => {
  const totalStaked = [...chainState.stakes.values()].reduce((s, p) => s + p.amount, 0);
  const totalUnbonding = chainState.unbondingQueue.reduce((s, u) => s + u.amount, 0);
  res.json({
    totalBondedStake: chainState.totalBondedStake,
    totalDelegated: totalStaked,
    totalUnbonding,
    validatorCount: chainState.validators.size,
    unbondingPeriodBlocks: 10,
    activeStakers: new Set([...chainState.stakes.values()].map(s => s.delegator)).size,
  });
});

export default router;
