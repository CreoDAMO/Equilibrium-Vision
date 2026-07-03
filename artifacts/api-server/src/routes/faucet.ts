import { Router } from "express";
import { chainState } from "../chain/index.js";

const DRIP_AMOUNT = 1_000_000_000;
const DRIP_COOLDOWN_SECONDS = 60 * 60;

const router = Router();
const drips = new Map<string, number>();

router.post("/faucet", (req, res) => {
  const { address } = req.body as { address?: string };

  if (!address || address.length !== 40) {
    res.status(400).json({ error: "Valid 40-char address required" });
    return;
  }

  const lastDrip = drips.get(address) ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const secondsSince = now - lastDrip;

  if (lastDrip > 0 && secondsSince < DRIP_COOLDOWN_SECONDS) {
    const wait = DRIP_COOLDOWN_SECONDS - secondsSince;
    res.status(429).json({
      error: "Rate limited — faucet cooldown active",
      waitSeconds: wait,
      nextDripAt: lastDrip + DRIP_COOLDOWN_SECONDS,
    });
    return;
  }

  chainState.ledger.credit(address, DRIP_AMOUNT);
  drips.set(address, now);

  res.json({
    success: true,
    address,
    amount: DRIP_AMOUNT,
    balance: chainState.ledger.balance(address),
    cooldownSeconds: DRIP_COOLDOWN_SECONDS,
  });
});

router.get("/faucet/status/:address", (req, res) => {
  const addr = req.params["address"]!;
  const lastDrip = drips.get(addr) ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const cooldownRemaining = lastDrip > 0 ? Math.max(0, DRIP_COOLDOWN_SECONDS - (now - lastDrip)) : 0;

  res.json({
    address: addr,
    lastDrip: lastDrip || null,
    cooldownRemaining,
    canDrip: cooldownRemaining === 0,
    dripAmount: DRIP_AMOUNT,
  });
});

export default router;
