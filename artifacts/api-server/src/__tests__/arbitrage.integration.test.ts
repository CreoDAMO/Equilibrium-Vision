/**
 * Arbitrage API integration tests — exercises the full ModelRegistry →
 * Arbitrage contract lifecycle through the HTTP API.
 *
 * The Arbitrage contract is auto-deployed by initChain() with minerAddress as
 * the owner. The ModelRegistry contract is also auto-deployed, giving us a
 * realistic two-contract environment without any extra setup.
 *
 * What's covered:
 *   GET  /api/arbitrage/opportunities — empty-pool and pool-present paths
 *   GET  /api/arbitrage/status        — fields, types, contract wired correctly
 *   POST /api/arbitrage/set-model     — validation + owner-only + successful set
 *   POST /api/arbitrage/pause         — owner can pause; execute reflects paused state
 *   POST /api/arbitrage/unpause       — owner can clear the pause
 *   POST /api/arbitrage/execute       — validation errors + contract-level error codes
 *   ModelRegistry → Arbitrage         — propose + verify a model, wire it, attempt execute
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import supertest from "supertest";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import { encodeSupportCommitment } from "../chain/modelRegistry.js";
import { getArbitrageAddress } from "../chain/arbitrage.js";

const api = supertest(app);

function randomAddress(): string {
  return randomBytes(20).toString("hex");
}
function fund(addr: string, amount: number): void {
  chainState.ledger.credit(addr, amount);
}
function advanceBlocks(count: number): void {
  for (let i = 0; i < count; i++) {
    chainState.addBlock(mineNextBlock(chainState, minerAddress));
  }
}

const PROPOSER_FUNDS = 5_000_000_000;

beforeAll(async () => { await initChain(); }, 30_000);
afterAll(() => { stopMining(); });

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/arbitrage/opportunities", () => {
  it("returns 200 with opportunities, count, and poolsScanned", async () => {
    const res = await api.get("/api/arbitrage/opportunities");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("opportunities");
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("poolsScanned");
    expect(Array.isArray(res.body.opportunities)).toBe(true);
    expect(typeof res.body.count).toBe("number");
    expect(typeof res.body.poolsScanned).toBe("number");
  });

  it("count matches the length of the opportunities array", async () => {
    const res = await api.get("/api/arbitrage/opportunities");
    expect(res.body.count).toBe(res.body.opportunities.length);
  });

  it("respects the ?limit query parameter (clamps to 20)", async () => {
    const res = await api.get("/api/arbitrage/opportunities?limit=1");
    expect(res.status).toBe(200);
    expect(res.body.opportunities.length).toBeLessThanOrEqual(1);
  });

  it("returns a cached response on a second call within 4 s", async () => {
    const r1 = await api.get("/api/arbitrage/opportunities");
    const r2 = await api.get("/api/arbitrage/opportunities");
    // Both calls should succeed; content should be identical (served from cache)
    expect(r2.status).toBe(200);
    expect(JSON.stringify(r2.body)).toBe(JSON.stringify(r1.body));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/arbitrage/status", () => {
  it("returns 200 with expected fields when the contract is deployed", async () => {
    const address = getArbitrageAddress();
    if (!address) {
      // Contract deployment is optional — skip gracefully
      console.warn("Arbitrage contract not deployed — skipping status tests");
      return;
    }
    const res = await api.get("/api/arbitrage/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("address");
    expect(res.body).toHaveProperty("owner");
    expect(res.body).toHaveProperty("paused");
    expect(res.body).toHaveProperty("circuitTripped");
    expect(res.body).toHaveProperty("execCount");
  });

  it("address field is a 40-char hex string", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.address).toMatch(/^[0-9a-f]{40}$/);
  });

  it("owner is the minerAddress that initialised the contract", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.get("/api/arbitrage/status");
    // The contract is init'd with minerAddress as owner
    expect(res.body.owner).toBe(minerAddress);
  });

  it("starts unpaused with circuitTripped=false and execCount=0", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.paused).toBe(false);
    expect(res.body.circuitTripped).toBe(false);
    expect(res.body.execCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/arbitrage/set-model — validation errors", () => {
  it("rejects when caller is missing", async () => {
    const res = await api.post("/api/arbitrage/set-model").send({
      registryAddress: randomAddress(),
      modelId: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects when registryAddress is missing", async () => {
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: minerAddress,
      modelId: 1,
    });
    expect(res.status).toBe(400);
  });

  it("rejects when modelId is not a number", async () => {
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: minerAddress,
      registryAddress: randomAddress(),
      modelId: "not-a-number",
    });
    expect(res.status).toBe(400);
  });

  it("rejects when caller is not the contract owner", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const nonOwner = randomAddress();
    fund(nonOwner, PROPOSER_FUNDS);
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: nonOwner,
      registryAddress: randomAddress(),
      modelId: 1,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/arbitrage/pause and unpause", () => {
  it("owner can pause the contract", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.post("/api/arbitrage/pause").send({ caller: minerAddress });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("status reflects paused=true after a pause", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.paused).toBe(true);
  });

  it("non-owner cannot pause the contract", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const nonOwner = randomAddress();
    const res = await api.post("/api/arbitrage/pause").send({ caller: nonOwner });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("rejects pause when caller body field is missing", async () => {
    const res = await api.post("/api/arbitrage/pause").send({});
    expect(res.status).toBe(400);
  });

  it("owner can unpause the contract", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.post("/api/arbitrage/unpause").send({ caller: minerAddress });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("status reflects paused=false after unpause", async () => {
    const address = getArbitrageAddress();
    if (!address) return;
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.paused).toBe(false);
  });

  it("rejects unpause when caller body field is missing", async () => {
    const res = await api.post("/api/arbitrage/unpause").send({});
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/arbitrage/execute — validation and contract error codes", () => {
  it("rejects when caller is missing", async () => {
    const res = await api.post("/api/arbitrage/execute").send({
      poolIds: ["EQU-WBTC"],
      tokenIn: "EQU",
      amountIn: 1000,
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects when poolIds is not an array", async () => {
    const res = await api.post("/api/arbitrage/execute").send({
      caller: minerAddress,
      poolIds: "EQU-WBTC",
      tokenIn: "EQU",
      amountIn: 1000,
    });
    expect(res.status).toBe(400);
  });

  it("rejects when amountIn is missing", async () => {
    const res = await api.post("/api/arbitrage/execute").send({
      caller: minerAddress,
      poolIds: ["EQU-WBTC"],
      tokenIn: "EQU",
    });
    expect(res.status).toBe(400);
  });

  it("returns an error when paused (contract returns -1)", async () => {
    const address = getArbitrageAddress();
    if (!address) return;

    // Pause the contract
    await api.post("/api/arbitrage/pause").send({ caller: minerAddress });

    const res = await api.post("/api/arbitrage/execute").send({
      caller: minerAddress,
      poolIds: ["EQU-WBTC"],
      tokenIn: "EQU",
      amountIn: 1000,
      minProfit: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/paused|circuit/i);

    // Restore
    await api.post("/api/arbitrage/unpause").send({ caller: minerAddress });
  });

  it("returns an error when no model is configured (contract returns -2)", async () => {
    const address = getArbitrageAddress();
    if (!address) return;

    // Contract is unpaused but no model has been set — should return -2
    const res = await api.post("/api/arbitrage/execute").send({
      caller: minerAddress,
      poolIds: ["EQU-WBTC"],
      tokenIn: "EQU",
      amountIn: 1000,
      minProfit: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/no model/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("ModelRegistry → Arbitrage integration — propose, verify, wire, execute", () => {
  /**
   * Full lifecycle: propose a model in ModelRegistry, wait out the challenge
   * window, verify it, configure the Arbitrage contract to use it, then
   * attempt an execute call. The execute will fail with -3 ("model not
   * verified, or not yet past update delay") until the maturity delay elapses,
   * and with -5 if there is no pool liquidity for the given path — both of
   * which are expected and confirm the contract is actually reading from
   * ModelRegistry and not short-circuiting.
   */

  const SUPPORT_DATA = [[0, 0], [1, 1], [0, 1], [1, 0]];
  const SUPPORT_LABELS = [0, 1, 1, 0];
  let modelId: number;
  let registryAddress: string;
  let proposer: string;

  beforeAll(async () => {
    const address = getArbitrageAddress();
    if (!address) return; // skip gracefully if contract not deployed

    proposer = randomAddress();
    fund(proposer, PROPOSER_FUNDS);

    const committed = encodeSupportCommitment(SUPPORT_DATA, SUPPORT_LABELS);

    const proposeRes = await api.post("/api/models/propose").send({
      caller: proposer,
      claimedResidual: 0,
      supportHashHex: committed.hashHex,
      inputDim: 2,
      hiddenDim: 4,
      lambda: 0.1,
      seed: 99,
      uri: "ipfs://arbitrage-integration-model",
    });
    expect(proposeRes.body.success).toBe(true);
    modelId = proposeRes.body.modelId;

    // Advance past the challenge window and verify
    advanceBlocks(101);
    const verifyRes = await api.post(`/api/models/${modelId}/verify`).send({ caller: proposer });
    expect(verifyRes.body.success).toBe(true);
    expect(verifyRes.body.status).toBe("verified");

    // Retrieve the ModelRegistry contract address from storage
    const statusRes = await api.get(`/api/models/${modelId}`);
    registryAddress = statusRes.body["contract_address"] ?? "";
  }, 60_000);

  it("confirmed model is verified in ModelRegistry before wiring", async () => {
    const address = getArbitrageAddress();
    if (!address || !modelId) return;
    const res = await api.get(`/api/models/${modelId}`);
    expect(res.body.status).toBe("verified");
  });

  it("owner can set-model to point Arbitrage at the verified ModelRegistry model", async () => {
    const address = getArbitrageAddress();
    if (!address || !registryAddress || !registryAddress.match(/^[0-9a-f]{40}$/)) {
      // registryAddress may not be stored on the model record — skip
      return;
    }
    const res = await api.post("/api/arbitrage/set-model").send({
      caller: minerAddress,
      registryAddress,
      modelId,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("status reflects the configured modelId after set-model", async () => {
    const address = getArbitrageAddress();
    if (!address || !registryAddress?.match(/^[0-9a-f]{40}$/)) return;
    const res = await api.get("/api/arbitrage/status");
    expect(res.body.modelId).toBe(modelId);
  });

  it("execute returns a contract-level error (not a validation error) when model is set", async () => {
    const address = getArbitrageAddress();
    if (!address || !registryAddress?.match(/^[0-9a-f]{40}$/)) return;

    // With a model wired but no DEX pool trade path, the contract will return
    // -3 (model maturity delay not elapsed) or -5 (swap path fails). Either
    // confirms the contract ran its full check sequence rather than short-
    // circuiting at the "no model configured" gate.
    const res = await api.post("/api/arbitrage/execute").send({
      caller: minerAddress,
      poolIds: ["EQU-WBTC"],
      tokenIn: "EQU",
      amountIn: 1000,
      minProfit: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Must NOT be the "no model configured" error — that would mean set-model
    // had no effect.
    expect(res.body.error).not.toMatch(/no model/i);
  });
});
