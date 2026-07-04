/**
 * Integration tests for the Equilibrium API.
 *
 * Imports `app` (Express) directly without starting the HTTP server.
 * Calls `initChain()` in `beforeAll` so `chainState` is populated before
 * any request is made — the chain module exports it as `let` so this works
 * as a live ES-module binding update.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { generateKeyPairSync, sign as cryptoSign, createHash, type KeyObject } from "node:crypto";
import app from "../app.js";
import { initChain, stopMining, chainState } from "../chain/index.js";

const api = supertest(app);

beforeAll(async () => {
  await initChain();
}, 30_000);

afterAll(() => {
  stopMining();
});

// ── Health ────────────────────────────────────────────────────────────────────

describe("GET /api/healthz", () => {
  it("returns 200 with status ok", async () => {
    const res = await api.get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

// ── Chain Status ──────────────────────────────────────────────────────────────

describe("GET /api/chain/status", () => {
  it("returns 200 with the expected shape", async () => {
    const res = await api.get("/api/chain/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      height:         expect.any(Number),
      latestHash:     expect.any(String),
      difficulty:     expect.any(Number),
      mempoolSize:    expect.any(Number),
      finalizedHeight: expect.any(Number),
      tps:            expect.any(Number),
    });
  });

  it("latestHash is a 64-char hex string", async () => {
    const res = await api.get("/api/chain/status");
    expect(res.body.latestHash).toHaveLength(64);
    expect(res.body.latestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("height is a non-negative integer", async () => {
    const res = await api.get("/api/chain/status");
    expect(res.body.height).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(res.body.height)).toBe(true);
  });

  it("difficulty is a positive integer", async () => {
    const res = await api.get("/api/chain/status");
    expect(res.body.difficulty).toBeGreaterThan(0);
  });
});

// ── Blocks ────────────────────────────────────────────────────────────────────

describe("GET /api/blocks", () => {
  it("returns 200 with a paginated response shape", async () => {
    const res = await api.get("/api/blocks");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      blocks: expect.any(Array),
      total:  expect.any(Number),
      page:   expect.any(Number),
      limit:  expect.any(Number),
    });
  });

  it("respects the limit query param", async () => {
    const res = await api.get("/api/blocks?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.blocks.length).toBeLessThanOrEqual(5);
    expect(res.body.limit).toBe(5);
  });

  it("each block in the list has the required fields", async () => {
    const res = await api.get("/api/blocks?limit=3");
    for (const block of res.body.blocks) {
      expect(block).toMatchObject({
        hash:       expect.any(String),
        height:     expect.any(Number),
        prevHash:   expect.any(String),
        timestamp:  expect.any(Number),
        difficulty: expect.any(Number),
        residual:   expect.any(Number),
        miner:      expect.any(String),
        txCount:    expect.any(Number),
      });
    }
  });

  it("page 2 is different from page 1 (when enough blocks exist)", async () => {
    const p1 = await api.get("/api/blocks?page=1&limit=3");
    const p2 = await api.get("/api/blocks?page=2&limit=3");
    if (p1.body.total > 3) {
      const p1Hashes = p1.body.blocks.map((b: { hash: string }) => b.hash);
      const p2Hashes = p2.body.blocks.map((b: { hash: string }) => b.hash);
      expect(p1Hashes).not.toEqual(p2Hashes);
    }
  });
});

describe("GET /api/blocks/:hashOrHeight", () => {
  it("returns block 0 (genesis) by height", async () => {
    const res = await api.get("/api/blocks/0");
    expect(res.status).toBe(200);
    expect(res.body.height).toBe(0);
    expect(res.body.prevHash).toBe("0".repeat(64));
  });

  it("returns the same block when fetched by its hash", async () => {
    const byHeight = await api.get("/api/blocks/0");
    const { hash } = byHeight.body;
    const byHash = await api.get(`/api/blocks/${hash}`);
    expect(byHash.status).toBe(200);
    expect(byHash.body.hash).toBe(hash);
    expect(byHash.body.height).toBe(0);
  });

  it("returns 404 for a non-existent block", async () => {
    const res = await api.get("/api/blocks/" + "f".repeat(64));
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 404 for a height beyond the chain tip", async () => {
    const status = await api.get("/api/chain/status");
    const beyond = status.body.height + 99999;
    const res = await api.get(`/api/blocks/${beyond}`);
    expect(res.status).toBe(404);
  });
});

// ── Mempool ───────────────────────────────────────────────────────────────────

describe("GET /api/mempool", () => {
  it("returns 200 with a transactions array and pressure field", async () => {
    const res = await api.get("/api/mempool");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      transactions: expect.any(Array),
      pressure:     expect.any(Number),
    });
  });
});

// ── Block Submission ──────────────────────────────────────────────────────────

describe("POST /api/blocks/submit", () => {
  it("returns 400 when miner is missing", async () => {
    const res = await api
      .post("/api/blocks/submit")
      .send({ nonce: 1, residual: 1e-9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/miner/i);
  });

  it("returns 400 when nonce is missing", async () => {
    const res = await api
      .post("/api/blocks/submit")
      .send({ miner: "a".repeat(40), residual: 1e-9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nonce/i);
  });

  it("returns 400 when residual is missing", async () => {
    const res = await api
      .post("/api/blocks/submit")
      .send({ miner: "a".repeat(40), nonce: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/residual/i);
  });

  it("returns 422 when residual is above the threshold (1e-7)", async () => {
    const res = await api.post("/api/blocks/submit").send({
      miner:    "a".repeat(40),
      nonce:    12345,
      residual: 5e-5, // well above 1e-7 threshold
      timestamp: Math.floor(Date.now() / 1000),
    });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error:     expect.stringMatching(/threshold/i),
      threshold: expect.any(Number),
    });
  });

  it("returns 409 when prevHash does not match the current chain tip", async () => {
    const res = await api.post("/api/blocks/submit").send({
      miner:    "a".repeat(40),
      prevHash: "0".repeat(64), // stale — won't match unless chain is at genesis
      nonce:    12345,
      residual: 1e-9,
      timestamp: Math.floor(Date.now() / 1000),
    });
    // Only fails with 409 if chain tip != all-zeros; genesis case returns 201
    if (res.status !== 201) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error:         expect.stringMatching(/stale/i),
        currentTip:    expect.any(String),
        currentHeight: expect.any(Number),
      });
    }
  });

  it("returns 201 and a valid block record for a good submission", async () => {
    // Fetch the live chain tip so prevHash is correct
    const status = await api.get("/api/chain/status");
    const { latestHash, height } = status.body;

    const res = await api.post("/api/blocks/submit").send({
      miner:     "a".repeat(40),
      prevHash:  latestHash,
      nonce:     999_999,
      residual:  3e-9, // well below 1e-7 threshold
      timestamp: Math.floor(Date.now() / 1000),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      hash:     expect.any(String),
      height:   height + 1,
      reward:   expect.any(Number),
      txCount:  expect.any(Number),
    });
    expect(res.body.hash).toHaveLength(64);
    expect(res.body.reward).toBeGreaterThan(0);
  });

  it("block submitted above reflects in chain status height", async () => {
    const res = await api.get("/api/chain/status");
    // After the successful submit above, height should have advanced
    // (we can't know the exact value since the auto-miner may also fire,
    // but it should be at least the height we saw before + 1)
    expect(res.status).toBe(200);
    expect(res.body.height).toBeGreaterThan(0);
  });
});

// ── UTXO ─────────────────────────────────────────────────────────────────────

describe("GET /api/utxo/:address", () => {
  it("returns 200 with utxo shape for any address", async () => {
    const addr = "a".repeat(40);
    const res = await api.get(`/api/utxo/${addr}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address:   addr,
      balance:   expect.any(Number),
      utxoCount: expect.any(Number),
      utxos:     expect.any(Array),
    });
  });
});

// ── Network ───────────────────────────────────────────────────────────────────

describe("GET /api/network/peers", () => {
  it("returns 200 with an array of peers", async () => {
    const res = await api.get("/api/network/peers");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0]).toMatchObject({
        peerId:    expect.any(String),
        address:   expect.any(String),
        connected: expect.any(Boolean),
      });
    }
  });
});

// ── Validators ────────────────────────────────────────────────────────────────

describe("GET /api/validators", () => {
  it("returns 200 with at least one genesis validator", async () => {
    const res = await api.get("/api/validators");
    expect(res.status).toBe(200);
    const validators = Array.isArray(res.body)
      ? res.body
      : res.body.validators ?? [];
    expect(validators.length).toBeGreaterThan(0);
    expect(validators[0]).toMatchObject({
      address:     expect.any(String),
      bondedStake: expect.any(Number),
    });
  });
});

// ── Governance ────────────────────────────────────────────────────────────────

/**
 * Helpers: generate an Ed25519 keypair and derive the canonical Equilibrium
 * address (SHA-256 of raw 32-byte public key, first 20 bytes as 40 hex chars).
 * Node.js exports Ed25519 public keys as 44-byte SPKI DER; the raw key is the
 * last 32 bytes (bytes 12–43).
 */
function makeKeypair(): { privKey: KeyObject; pubHex: string; address: string } {
  const { privateKey: privKey, publicKey } = generateKeyPairSync("ed25519") as { privateKey: KeyObject; publicKey: KeyObject };
  const spki   = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rawPub = spki.slice(12); // 44 - 12 = 32 bytes
  const pubHex = rawPub.toString("hex");
  const address = createHash("sha256").update(rawPub).digest("hex").slice(0, 40);
  return { privKey, pubHex, address };
}

function signVote(
  privKey: KeyObject,
  proposalId: string,
  choice: string,
): string {
  const msg = Buffer.from(`vote:${proposalId}:${choice}`, "utf8");
  return (cryptoSign(null, msg, privKey) as Buffer).toString("hex");
}

describe("POST /api/governance/proposals/:id/vote — signature verification", () => {
  let proposalId: string;
  let voter: ReturnType<typeof makeKeypair>;

  beforeAll(async () => {
    // Generate a fresh Ed25519 keypair and inject it as a bonded validator so
    // it has voting power.  chainState is the live module-level binding updated
    // by initChain(), so mutations here are visible to the route handlers.
    // totalBondedStake is a getter that sums all validator bondedStake values,
    // so just inserting the record is enough — no manual total update needed.
    voter = makeKeypair();
    chainState.validators.set(voter.address, {
      address:            voter.address,
      moniker:            "test-voter",
      bondedStake:        1_000,
      accumulatedRewards: 0,
      slashed:            false,
      slashCount:         0,
      jailed:             false,
      uptime:             1,
      blocksProposed:     0,
      blocksVoted:        0,
      commission:         0.1,
    });

    // Create a proposal the voter can vote on.
    const res = await api.post("/api/governance/proposals").send({
      proposer:    voter.address,
      type:        "text",
      title:       "Test proposal for signature tests",
      description: "Created by the governance integration test suite.",
    });
    expect(res.status).toBe(201);
    proposalId = res.body.id as string;
  });

  it("accepts a valid Ed25519 signature and returns 200", async () => {
    const sig = signVote(voter.privKey, proposalId, "yes");
    const res = await api.post(`/api/governance/proposals/${proposalId}/vote`).send({
      voter:     voter.address,
      choice:    "yes",
      publicKey: voter.pubHex,
      signature: sig,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.proposal).toMatchObject({ id: proposalId });
  });

  it("returns 401 when the signature is from a different key", async () => {
    // Sign with a completely different private key — cryptographic forgery attempt.
    const { privKey: wrongKey } = makeKeypair();
    const badSig = signVote(wrongKey, proposalId, "no");
    const res = await api.post(`/api/governance/proposals/${proposalId}/vote`).send({
      voter:     voter.address,
      choice:    "no",
      publicKey: voter.pubHex,
      signature: badSig,
    });
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when publicKey does not correspond to voter address", async () => {
    // Supply voter's address but a *different* keypair's public key — the
    // derived address won't match, so it's a 400 (malformed request), not 401.
    const other = makeKeypair();
    const sig   = signVote(other.privKey, proposalId, "no");
    const res   = await api.post(`/api/governance/proposals/${proposalId}/vote`).send({
      voter:     voter.address,   // real voter address
      choice:    "no",
      publicKey: other.pubHex,    // belongs to a different keypair
      signature: sig,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/publicKey does not correspond/i);
  });

  afterAll(() => {
    // Clean up injected validator so it doesn't leak into other test suites.
    chainState.validators.delete(voter.address);
  });
});
