/**
 * ModelRegistry integration tests — exercises the full permissionless
 * optimistic-oracle lifecycle through the HTTP API: propose -> verify
 * (challenge window elapses undisputed) and propose -> challenge -> slash
 * (challenge disproves the claim). See contracts/model_registry/src/lib.rs
 * for the on-chain state machine and artifacts/api-server/src/chain/
 * modelRegistry.ts for the wire encoding.
 *
 * A caller string is not authority. Every mutating request is signed over
 * its action and body. The inference attestor signature is a different proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "crypto";
import supertest from "supertest";
import { ed25519 } from "@noble/curves/ed25519.js";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import { encodeSupportCommitment } from "../chain/modelRegistry.js";
import { addressFromPublicKey, authorityMessage } from "../lib/signed-caller.js";

const api = supertest(app);

interface CallerKey {
  pair: { privateKey: KeyObject };
  publicKey: string;
  caller: string;
}

function callerKey(): CallerKey {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const publicKey = raw.toString("hex");
  return { pair, publicKey, caller: addressFromPublicKey(publicKey) };
}

function signed(pair: CallerKey, path: string, body: Record<string, unknown>): Record<string, unknown> {
  const signature = sign(null, Buffer.from(authorityMessage(`POST ${path}`, body), "utf8"), pair.pair.privateKey).toString("hex");
  return { ...body, publicKey: pair.publicKey, signature };
}

function fund(addr: string, amount: number): void {
  chainState.ledger.credit(addr, amount);
}

function advanceBlocks(count: number): void {
  for (let i = 0; i < count; i++) {
    // mineNextBlock admits the block. Adding it again is not a successor.
    mineNextBlock(chainState, minerAddress);
  }
}

const PROPOSER_FUNDS = 5_000_000_000;
const CHALLENGER_FUNDS = 2_000_000_000;

const PROPOSE = "/api/models/propose";

function proposeBody(caller: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    caller,
    claimedResidual: 0,
    supportHashHex: "aa".repeat(32),
    inputDim: 2,
    hiddenDim: 4,
    lambda: 0.1,
    seed: 1,
    uri: "ipfs://model",
    ...fields,
  };
}

beforeAll(async () => { await initChain(); }, 30_000);
afterAll(() => { stopMining(); });

describe("Models API — propose -> verify (undisputed)", () => {
  let modelId: number;
  let proposer: CallerKey;

  beforeAll(async () => {
    proposer = callerKey();
    fund(proposer.caller, PROPOSER_FUNDS);

    const res = await api.post(PROPOSE).send(signed(proposer, PROPOSE, proposeBody(proposer.caller, {
      supportHashHex: "aa".repeat(32),
      uri: "ipfs://undisputed-model",
    })));
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
    expect(res.body["model_proposer"]).toBe(proposer.caller);
    expect(res.body["model_uri"]).toBe("ipfs://undisputed-model");
  });

  it("appears in GET /api/models", async () => {
    const res = await api.get("/api/models");
    expect(res.status).toBe(200);
    expect(res.body.models.some((m: { id: number }) => m.id === modelId)).toBe(true);
  });

  it("verify fails while the challenge window is still open", async () => {
    const path = `/api/models/${modelId}/verify`;
    const res = await api.post(path).send(signed(proposer, path, { caller: proposer.caller }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/challenge window/i);
  });

  it("verify succeeds once the challenge window has elapsed, flipping status to verified", async () => {
    advanceBlocks(101); // modelRegistryChallengePeriod default = 100
    const path = `/api/models/${modelId}/verify`;
    const res = await api.post(path).send(signed(proposer, path, { caller: proposer.caller }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("verified");

    const getRes = await api.get(`/api/models/${modelId}`);
    expect(getRes.body.status).toBe("verified");
  });

  it("re-verifying an already-verified model is a no-op success", async () => {
    const path = `/api/models/${modelId}/verify`;
    const res = await api.post(path).send(signed(proposer, path, { caller: proposer.caller }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("verified");
  });
});

describe("Models API — challenge rejects data that doesn't match the committed hash", () => {
  let modelId: number;
  let challenger: CallerKey;

  beforeAll(async () => {
    const proposer = callerKey();
    challenger = callerKey();
    fund(proposer.caller, PROPOSER_FUNDS);
    fund(challenger.caller, CHALLENGER_FUNDS);

    const committed = encodeSupportCommitment([[0, 0], [1, 1]], [0, 1]);
    const res = await api.post(PROPOSE).send(signed(proposer, PROPOSE, proposeBody(proposer.caller, {
      supportHashHex: committed.hashHex,
      seed: 7,
      uri: "ipfs://hash-mismatch-model",
    })));
    expect(res.body.success).toBe(true);
    modelId = res.body.modelId;
  });

  it("returns an error when the posted support set doesn't hash to the committed value", async () => {
    const path = `/api/models/${modelId}/challenge`;
    const res = await api.post(path).send(signed(challenger, path, {
      caller: challenger.caller,
      supportData: [[9, 9], [8, 8]],
      supportLabels: [0, 1],
    }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it("model remains in 'proposed' status after a rejected challenge", async () => {
    const res = await api.get(`/api/models/${modelId}`);
    expect(res.body.status).toBe("proposed");
  });
});

describe("Models API — challenge slashes a model whose claimed residual is provably wrong", () => {
  const SUPPORT_DATA = [[0, 0], [1, 1], [2, 0], [0, 2]];
  const SUPPORT_LABELS = [0, 1, 1, 0];
  let modelId: number;
  let proposer: CallerKey;
  let challenger: CallerKey;
  let challengerBalanceBefore: number;

  beforeAll(async () => {
    proposer = callerKey();
    challenger = callerKey();
    fund(proposer.caller, PROPOSER_FUNDS);
    fund(challenger.caller, CHALLENGER_FUNDS);

    const committed = encodeSupportCommitment(SUPPORT_DATA, SUPPORT_LABELS);
    const res = await api.post(PROPOSE).send(signed(proposer, PROPOSE, proposeBody(proposer.caller, {
      claimedResidual: 999_999,
      supportHashHex: committed.hashHex,
      seed: 42,
      uri: "ipfs://slashed-model",
    })));
    expect(res.body.success).toBe(true);
    modelId = res.body.modelId;

    challengerBalanceBefore = chainState.ledger.balance(challenger.caller);
  });

  it("a matching challenge disproves the claim and slashes the model", async () => {
    const path = `/api/models/${modelId}/challenge`;
    const res = await api.post(path).send(signed(challenger, path, {
      caller: challenger.caller,
      supportData: SUPPORT_DATA,
      supportLabels: SUPPORT_LABELS,
    }));
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
    const after = chainState.ledger.balance(challenger.caller);
    expect(after).toBeGreaterThanOrEqual(challengerBalanceBefore);
  });

  it("a slashed model can no longer be verified", async () => {
    advanceBlocks(101);
    const path = `/api/models/${modelId}/verify`;
    const res = await api.post(path).send(signed(proposer, path, { caller: proposer.caller }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe("slashed");
  });
});

describe("Models API — validation errors", () => {
  it("rejects propose with a missing caller", async () => {
    const res = await api.post(PROPOSE).send({
      claimedResidual: 0, supportHashHex: "aa".repeat(32), inputDim: 2, hiddenDim: 4, lambda: 0.1, seed: 1, uri: "x",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unsigned caller before it reads the numeric fields", async () => {
    const res = await api.post(PROPOSE).send({ caller: callerKey().caller });
    expect(res.status).toBe(401);
  });

  it("rejects a signed propose that omits the numeric fields", async () => {
    const pair = callerKey();
    const res = await api.post(PROPOSE).send(signed(pair, PROPOSE, { caller: pair.caller }));
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
    const proposer = callerKey();
    fund(proposer.caller, PROPOSER_FUNDS);
    const proposeRes = await api.post(PROPOSE).send(signed(proposer, PROPOSE, proposeBody(proposer.caller, {
      supportHashHex: "bb".repeat(32),
      seed: 2,
      uri: "x",
    })));
    const id = proposeRes.body.modelId;
    const challenger = callerKey();
    const path = `/api/models/${id}/challenge`;
    const res = await api.post(path).send(signed(challenger, path, {
      caller: challenger.caller,
      supportData: "nope",
      supportLabels: "nope",
    }));
    expect(res.status).toBe(400);
  });

  it("rejects propose when the caller has insufficient balance for the bond", async () => {
    const poor = callerKey();
    const res = await api.post(PROPOSE).send(signed(poor, PROPOSE, proposeBody(poor.caller, {
      supportHashHex: "cc".repeat(32),
      seed: 3,
      uri: "x",
    })));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/insufficient balance/i);
  });
});

describe("Models API — inference attestation (method 5/6)", () => {
  let modelId: number;
  let submitter: CallerKey;

  function addressFromPubkey(pubkey: Uint8Array): string {
    return createHash("sha256").update(Buffer.from(pubkey)).digest("hex").slice(0, 40);
  }

  function signAttestation(priv: Uint8Array, inputHash: Buffer, outputHash: Buffer, id: number) {
    const idBuf = Buffer.alloc(4);
    idBuf.writeInt32LE(id, 0);
    const msg = Buffer.concat([inputHash, outputHash, idBuf]);
    return ed25519.sign(msg, priv);
  }

  beforeAll(async () => {
    const proposer = callerKey();
    submitter = callerKey();
    fund(proposer.caller, PROPOSER_FUNDS);
    const res = await api.post(PROPOSE).send(signed(proposer, PROPOSE, proposeBody(proposer.caller, {
      supportHashHex: "dd".repeat(32),
      seed: 4,
      uri: "ipfs://inference-model",
    })));
    expect(res.status).toBe(200);
    modelId = res.body.modelId;
  });

  it("GET inference-status is 'none' before any attestation", async () => {
    const res = await api.get(`/api/models/${modelId}/inference-status`);
    expect(res.status).toBe(200);
    expect(res.body.inferenceStatus).toBe("none");
  });

  it("accepts a validly-signed inference attestation and reflects it in status", async () => {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    const attestorAddress = addressFromPubkey(pub);
    const inputHash = createHash("sha256").update("model-input").digest();
    const outputHash = createHash("sha256").update("model-output").digest();
    const sig = signAttestation(priv, inputHash, outputHash, modelId);
    const path = `/api/models/${modelId}/inference-proof`;

    const res = await api.post(path).send(signed(submitter, path, {
      caller: submitter.caller,
      inputHashHex: inputHash.toString("hex"),
      outputHashHex: outputHash.toString("hex"),
      signatureHex: Buffer.from(sig).toString("hex"),
      pubkeyHex: Buffer.from(pub).toString("hex"),
      attestorAddress,
    }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const statusRes = await api.get(`/api/models/${modelId}/inference-status`);
    expect(statusRes.body.inferenceStatus).toBe("attested");
  });

  it("rejects an attestation whose signature does not match the claimed attestor", async () => {
    const priv = ed25519.utils.randomSecretKey();
    const pub = ed25519.getPublicKey(priv);
    const wrongAttestor = "ab".repeat(20);
    const inputHash = createHash("sha256").update("bad-input").digest();
    const outputHash = createHash("sha256").update("bad-output").digest();
    const sig = signAttestation(priv, inputHash, outputHash, modelId);
    const path = `/api/models/${modelId}/inference-proof`;

    const res = await api.post(path).send(signed(submitter, path, {
      caller: submitter.caller,
      inputHashHex: inputHash.toString("hex"),
      outputHashHex: outputHash.toString("hex"),
      signatureHex: Buffer.from(sig).toString("hex"),
      pubkeyHex: Buffer.from(pub).toString("hex"),
      attestorAddress: wrongAttestor,
    }));
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/invalid attestor signature/i);
  });

  it("returns 404 for inference-status on an unknown model id", async () => {
    const res = await api.get("/api/models/999999/inference-status");
    expect(res.status).toBe(404);
  });
});
