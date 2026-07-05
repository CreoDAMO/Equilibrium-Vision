import { Router } from "express";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { eq } from "drizzle-orm";
import { faucetDripsTable } from "@workspace/db/schema";
import { chainState } from "../chain/index.js";

const DRIP_AMOUNT = 1_000_000_000;
const DRIP_COOLDOWN_SECONDS = 60 * 60;

const HEX_ADDR = /^[0-9a-f]{40}$/;

const router = Router();

type Db = ReturnType<typeof drizzle>;

let _db: Db | null = null;
function getDb(): Db | null {
  if (_db) return _db;
  const url = process.env["DATABASE_URL"];
  if (!url) return null;
  const pool = new pg.Pool({ connectionString: url });
  _db = drizzle(pool, { schema: { faucetDripsTable } });
  return _db;
}

async function getLastDrip(address: string): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const rows = await db.select().from(faucetDripsTable).where(eq(faucetDripsTable.address, address));
    return rows[0]?.lastDripAt ?? 0;
  } catch {
    return 0;
  }
}

async function setLastDrip(address: string, ts: number): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(faucetDripsTable)
      .values({ address, lastDripAt: ts })
      .onConflictDoUpdate({ target: faucetDripsTable.address, set: { lastDripAt: ts } });
  } catch {
    // Best-effort — don't fail the faucet request if DB write fails
  }
}

router.post("/faucet", async (req, res) => {
  const { address } = req.body as { address?: string };

  if (!address || !HEX_ADDR.test(address)) {
    res.status(400).json({ error: "Valid 40-char lowercase hex address required" });
    return;
  }

  const lastDrip = await getLastDrip(address);
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
  await setLastDrip(address, now);

  res.json({
    success: true,
    address,
    amount: DRIP_AMOUNT,
    balance: chainState.ledger.balance(address),
    cooldownSeconds: DRIP_COOLDOWN_SECONDS,
  });
});

router.get("/faucet/status/:address", async (req, res) => {
  const addr = req.params["address"]!;
  const lastDrip = await getLastDrip(addr);
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
