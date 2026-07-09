/**
 * Arbitrage contract integration tests — exercises all five API surfaces:
 *
 *   GET  /api/arbitrage/opportunities   (read-only Bellman-Ford scan)
 *   GET  /api/arbitrage/status          (contract storage snapshot)
 *   POST /api/arbitrage/set-model       (owner-gated)
 *   POST /api/arbitrage/pause           (owner-gated)
 *   POST /api/arbitrage/unpause         (owner-gated)
 *   POST /api/arbitrage/execute         (permissionless HTTP, owner-gated inside contract)
 *
 * See contracts/arbitrage/src/lib.rs for the on-chain state machine and
 * LIMITATIONS.md §1 for the minProfit advisory (not a revert guard) behaviour.
 *
 * NOTE: The contract owner address is read from GET /api/arbitrage/status
 * at test startup rather than being hardcoded — multiple test files share
 * the same initChain() call and the miner address can vary across runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import supertest from "supertest";
import app from "../app.js";
import { initChain, stopMining, chainState } from "../chain/index.js";

const api = supertest(app);

function randomAddress(): string {
  return randomBytes(20).toString("hex");
}

function fund(addr: string, amount: number): void {
  chainState.ledger.credit(addr, amount);
}

let contractOwner: string;

beforeAll(async () => {
  await initChain();
  // Discover the actual owner from live contract storage so the tests are
  // correct even when multiple test files share the same chain init.
  const statusRes = await api.get("/api/arbitrage/status");
  contractOwner = statusRes.body.owner as string;
}, 30_000);

afterAll(() => { stopMining(); });

// ── GET /api/arbitrage/opportunities ─────────────────────────────────────────

describe("GET /api/arbitrage/opportunities", () => {
  it("returns 200 with the expected shape", async () => {
    const res = await api.get("/api/arbitrage/opportunities");
    expect(res.status).toBe(200);
    expect(typeof res.body.count).toBe("number");
    expect(Array.isArray(res.body.opportunities)).toBe(true);
    expect(typeof res.body.poolsScanned).toBe("number");
  });

  it("honours the ?limit query param (capped at 20)", async () => {
    const res = await api.get("/api/arbitrage/opportunities?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.opportunities.length).toBeLessThanOrEqual(2);
  });

  it("clamps an oversized limit to 20", async () => {
    const res = await api.get("/api/arbitrage/opportunities?limit=999");
    expect(res.status).toBe(200);
    expect(res.body.opportunities.length).toBeLessThanOrEqual(20);
  });

  it("each opportunity has the required fields when present", async () => {
    const res = await api.get("/api/arbitrage/opportunities");
    for (const opp of res.body.opportunities as unknown[]) {
      const o = opp as Record<string, unknown>;
      expect(Array.isArray(o["path"])).toBe(true);
      expect(typeof o["profit_ratio"]).toBe("number");
    }
  });
});

// ── GET /api/arbitrage/status ─────────────────────────────────────────────────

describe("GET /api/arbitrage/status", () => {
  it("returns 200 with a valid contract address once initChain has deployed it", async () => {
    const res = await api.get("/api/arbitrage/status");
    expect(res.status).toBe(200);
    expect(typeof res.body.address).toBe("string");
    expect(res.body.address).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports circuitTripped=false on a fresh deployment", async () => {
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.circuitTripped).toBe(false);
  });

  it("reports an owner address (40 hex chars)", async () => {
    const res = await api.get("/api/arbitrage/status");
    expect(typeof res.body.owner).toBe("string");
    expect(res.body.owner).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports a numeric execCount", async () => {
    const res = await api.get("/api/arbitrage/status");
    expect(typeof res.body.execCount).toBe("number");
    expect(res.body.execCount).toBeGreaterThanOrEqual(0);
  });
});

// ── POST /api/arbitrage/pause + unpause (no ADMIN_KEY set → dev convenience) ─

describe("POST /api/arbitrage/pause + unpause (dev mode — no ADMIN_KEY)", () => {
  it("pause returns success when called by the contract owner", async () => {
    const res = await api.post("/api/arbitrage/pause").send({ caller: contractOwner });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("GET /api/arbitrage/status reflects paused=true", async () => {
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.paused).toBe(true);
  });

  it("unpause restores paused=false", async () => {
    const unpauseRes = await api.post("/api/arbitrage/unpause").send({ caller: contractOwner });
    expect(unpauseRes.status).toBe(200);
    expect(unpauseRes.body.success).toBe(true);

    const statusRes = await api.get("/api/arbitrage/status");
    expect(statusRes.body.paused).toBe(false);
  });

  it("a non-owner cannot pause the contract", async () => {
    const stranger = randomAddress();
    const res = await api.post("/api/arbitrage/pause").send({ caller: stranger });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("pause requires a caller field", async () => {
    const res = await api.post("/api/arbitrage/pause").send({});
    expect(res.status).toBe(400);
  });

  it("unpause requires a caller field", async () => {
    const res = await api.post("/api/arbitrage/unpause").send({});
    expect(res.status).toBe(400);
  });
});

// ── POST /api/arbitrage/set-model ─────────────────────────────────────────────

describe("POST /api/arbitrage/set-model (dev mode — no ADMIN_KEY)", () => {
  it("rejects a request missing caller / registryAddress / modelId", async () => {
    const res = await api.post("/api/arbitrage/set-model").send({ caller: contractOwner });
    expect(res.status).toBe(400);
  });

  it("rejects a non-owner caller", async () => {
    const arbitrageStatus = await api.get("/api/arbitrage/status");
    const stranger = randomAddress();
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: stranger,
      registryAddress: arbitrageStatus.body.address,
      modelId: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ── POST /api/arbitrage/execute — validation errors ───────────────────────────

describe("POST /api/arbitrage/execute — validation errors", () => {
  it("rejects a request missing required fields", async () => {
    const res = await api.post("/api/arbitrage/execute").send({ caller: randomAddress() });
    expect(res.status).toBe(400);
  });

  it("rejects poolIds that is not an array", async () => {
    const res = await api.post("/api/arbitrage/execute").send({
      caller: randomAddress(),
      poolIds: "EQU-WBTC",
      tokenIn: "EQU",
      amountIn: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("returns a well-formed error or success response shape", async () => {
    const caller = randomAddress();
    fund(caller, 100_000_000);
    const res = await api.post("/api/arbitrage/execute").send({
      caller,
      poolIds: ["EQU-WBTC", "WBTC-USDC"],
      tokenIn: "EQU",
      amountIn: 100,
      minProfit: 0,
    });
    // Contract may return a contract-level error (400) or a success (200).
    // Either way, the body must have a well-defined shape.
    if (res.status === 400) {
      expect(typeof res.body.error).toBe("string");
      expect(res.body.success).toBe(false);
    } else {
      expect(res.status).toBe(200);
      expect(typeof res.body.success).toBe("boolean");
    }
  });
});

// ── ADMIN_KEY enforcement ─────────────────────────────────────────────────────

describe("ADMIN_KEY enforcement on owner-gated endpoints", () => {
  const FAKE_KEY = "test-admin-key-" + randomBytes(8).toString("hex");

  beforeAll(() => {
    process.env["ADMIN_KEY"] = FAKE_KEY;
  });

  afterAll(() => {
    delete process.env["ADMIN_KEY"];
  });

  it("pause returns 403 when X-Admin-Key header is absent", async () => {
    const res = await api.post("/api/arbitrage/pause").send({ caller: contractOwner });
    expect(res.status).toBe(403);
  });

  it("pause returns 403 when X-Admin-Key header has the wrong value", async () => {
    const res = await api
      .post("/api/arbitrage/pause")
      .set("X-Admin-Key", "wrong-key")
      .send({ caller: contractOwner });
    expect(res.status).toBe(403);
  });

  it("pause succeeds when the correct X-Admin-Key header is sent", async () => {
    const res = await api
      .post("/api/arbitrage/pause")
      .set("X-Admin-Key", FAKE_KEY)
      .send({ caller: contractOwner });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("unpause succeeds with the correct key", async () => {
    const res = await api
      .post("/api/arbitrage/unpause")
      .set("X-Admin-Key", FAKE_KEY)
      .send({ caller: contractOwner });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("set-model returns 403 without the header", async () => {
    const arbitrageStatus = await api.get("/api/arbitrage/status");
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: contractOwner,
      registryAddress: arbitrageStatus.body.address,
      modelId: 0,
    });
    expect(res.status).toBe(403);
  });
});
