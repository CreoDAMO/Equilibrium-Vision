/**
 * ModelRegistry integration tests — exercises the full permissionless
 * optimistic-oracle lifecycle through the HTTP API: propose -> verify
 * (challenge window elapses undisputed) and propose -> challenge -> slash
 * (challenge disproves the claim). See contracts/model_registry/src/lib.rs
 * for the on-chain state machine and artifacts/api-server/src/chain/
 * modelRegistry.ts for the wire encoding.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import supertest from "supertest";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import { encodeSupportCommitment } from "../chain/modelRegistry.js";

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
const CHALLENGER_FUNDS = 2_000_000_000;

beforeAll(async () => { await initChain(); }, 30_000);
afterAll(() => { stopMining(); });

// ─────────────────────────────────────────────────────────────────────────────

describe("Models API — propose -> verify (undisputed)", () => {
  let modelId: number;
  let proposer: string;

  beforeAll(async () => {
    proposer = randomAddress();
    fund(proposer, PROPOSER_FUNDS);

    const res = await api.post("/api/models/propose").send({
      caller: proposer,
      claimedResidual: 0,
      supportHashHex: "aa".repeat(32),
      inputDim: 2,
      hiddenDim: 4,
      lambda: 0.1,
      seed: 1,
      uri: "ipfs://undisputed-model",
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    modelId = res.body.modelId;
  });

  it("returns a numeric modelId on propose", () => {
    expect(Number.isInteger(modelId)).toBe(true);
  });

  it("GET /api/models/:id reports status 'proposed' with the proposer recorded", async () => {
    const res = await api.get(`/api/models/${modelId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("proposed");
    expect(res.body["model_proposer"]).toBe(proposer);
    expect(res.body["model_uri"]).toBe("ipfs://undisputed-model");
  });

  it("appears in GET /api/models", async () => {
    const res = await api.get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.models.some((m: { id: number }) => m.id === modelId)).toBe(true);
  });

  it("verify fails while the challenge window is still open", async () => {
    const res = await api.post(`/api/models/${modelId}/verify`).send({ caller: proposer });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/challenge window/i);
  });

  it("verify succeeds once the challenge window has elapsed, flipping status to verified", async () => {
    advanceBlocks(101); // modelRegistryChallengePeriod default = 100
    const res = await api.post(`/api/models/${modelId}/verify`).send({ caller: proposer });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("verified");

    const getRes = await api.get(`/api/models/${modelId}`);
    expect(getRes.body.status).toBe("verified");
  });

  it("re-verifying an already-verified model is a no-op success", async () => {
    const res = await api.post(`/api/models/${modelId}/verify`).send({ caller: proposer });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("verified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Models API — challenge rejects data that doesn't match the committed hash", () => {
  let modelId: number;
  let proposer: string;
  let challenger: string;

  beforeAll(async () => {
    proposer = randomAddress();
    challenger = randomAddress();
    fund(proposer, PROPOSER_FUNDS);
    fund(challenger, CHALLENGER_FUNDS);

    const committed = encodeSupportCommitment([[0, 0], [1, 1]], [0, 1]);
    const res = await api.post("/api/models/propose").send({
      caller: proposer,
      claimedResidual: 0,
      supportHashHex: committed.hashHex,
      inputDim: 2,
      hiddenDim: 4,
      lambda: 0.1,
      seed: 7,
      uri: "ipfs://hash-mismatch-model",
    });
    expect(res.body.success).toBe(true);
    modelId = res.body.modelId;
  });

  it("returns an error when the posted support set doesn't hash to the committed value", async () => {
    const res = await api.post(`/api/models/${modelId}/challenge`).send({
      caller: challenger,
      supportData: [[9, 9], [8, 8]], // does not match the commitment above
      supportLabels: [0, 1],
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it("model remains in 'proposed' status after a rejected challenge", async () => {
    const res = await api.get(`/api/models/${modelId}`);
    expect(res.body.status).toBe("proposed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Models API — challenge slashes a model whose claimed residual is provably wrong", () => {
  const SUPPORT_DATA = [[0, 0], [1, 1], [2, 0], [0, 2]];
  const SUPPORT_LABELS = [0, 1, 1, 0];
  let modelId: number;
  let proposer: string;
  let challenger: string;
  let challengerBalanceBefore: number;

  beforeAll(async () => {
    proposer = randomAddress();
    challenger = randomAddress();
    fund(proposer, PROPOSER_FUNDS);
    fund(challenger, CHALLENGER_FUNDS);

    const committed = encodeSupportCommitment(SUPPORT_DATA, SUPPORT_LABELS);
    const res = await api.post("/api/models/propose").send({
      caller: proposer,
      claimedResidual: 999_999, // wildly wrong on purpose — real NTK gradient-norm residuals are small
      supportHashHex: committed.hashHex,
      inputDim: 2,
      hiddenDim: 4,
      lambda: 0.1,
      seed: 42,
      uri: "ipfs://slashed-model",
    });
    expect(res.body.success).toBe(true);
    modelId = res.body.modelId;

    challengerBalanceBefore = chainState.ledger.balance(challenger);
  });

  it("a matching challenge disproves the claim and slashes the model", async () => {
    const res = await api.post(`/api/models/${modelId}/challenge`).send({
      caller: challenger,
      supportData: SUPPORT_DATA,
      supportLabels: SUPPORT_LABELS,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.outcome).toBe("slashed");
  }, 15_000);

  it("model status flips to 'slashed'", async () => {
    const res = await api.get(`/api/models/${modelId}`);
    expect(res.body.status).toBe("slashed");
  });

  it("shows as slashed in the model list too", async () => {
    const res = await api.get("/api/models");
    const entry = res.body.models.find((m: { id: number }) => m.id === modelId);
    expect(entry.status).toBe("slashed");
  });

  it("the challenger is paid a reward and refunded their bond", async () => {
    const after = chainState.ledger.balance(challenger);
    // Challenger posted a bond (debited) then received bond refund + a slashing reward
    // (credited) — net effect for a successful challenge must be non-negative.
    expect(after).toBeGreaterThanOrEqual(challengerBalanceBefore);
  });

  it("a slashed model can no longer be verified", async () => {
    advanceBlocks(101);
    const res = await api.post(`/api/models/${modelId}/verify`).send({ caller: proposer });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("slashed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Models API — validation errors", () => {
  it("rejects propose with a missing caller", async () => {
    const res = await api.post("/api/models/propose").send({
      claimedResidual: 0, supportHashHex: "aa".repeat(32), inputDim: 2, hiddenDim: 4, lambda: 0.1, seed: 1, uri: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects propose with missing numeric fields", async () => {
    const res = await api.post("/api/models/propose").send({ caller: randomAddress() });
    expect(res.status).toBe(400);
  });

  it("GET /api/models/:id returns 404 for an unknown id", async () => {
    const res = await api.get("/api/models/999999");
    expect(res.status).toBe(404);
  });

  it("GET /api/models/:id returns 400 for a non-numeric id", async () => {
    const res = await api.get("/api/models/not-a-number");
    expect(res.status).toBe(400);
  });

  it("rejects challenge with non-array supportData/supportLabels", async () => {
    const proposer = randomAddress();
    fund(proposer, PROPOSER_FUNDS);
    const proposeRes = await api.post("/api/models/propose").send({
      caller: proposer, claimedResidual: 0, supportHashHex: "bb".repeat(32),
      inputDim: 2, hiddenDim: 4, lambda: 0.1, seed: 2, uri: "x",
    });
    const id = proposeRes.body.modelId;
    const res = await api.post(`/api/models/${id}/challenge`).send({ caller: randomAddress(), supportData: "nope", supportLabels: "nope" });
    expect(res.status).toBe(400);
  });

  it("rejects propose when the caller has insufficient balance for the bond", async () => {
    const poorProposer = randomAddress(); // never funded
    const res = await api.post("/api/models/propose").send({
      caller: poorProposer, claimedResidual: 0, supportHashHex: "cc".repeat(32),
      inputDim: 2, hiddenDim: 4, lambda: 0.1, seed: 3, uri: "x",
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });
});
