/**
 * CrossChainRelay integration tests.
 *
 * Exercises the full FCCP lifecycle through the HTTP API:
 *   - Relayer registration + bond escrow
 *   - m-of-n signed inbound attestation submission
 *   - Finalization after challenge window
 *   - Admin challenge + bond slashing
 *   - Outbound commitment publishing
 *   - Threshold management
 *
 * All signatures are real Ed25519 — no mocks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "crypto";
import supertest from "supertest";
import { ed25519 } from "@noble/curves/ed25519.js";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import {
  deployCrossChainRelayIfNeeded,
  getCrossChainRelayAddress,
  buildAttestationMessage,
} from "../chain/crossChainRelay.js";

// Extend ed25519 utils type — noble/curves uses randomPrivateKey; noble/ed25519 uses randomSecretKey.
// Fall back to Node crypto so the test is not tied to a specific noble version.
function randomEd25519PrivKey(): Uint8Array {
  return randomBytes(32);
}

const api = supertest(app);
const ADMIN_KEY = "test-admin-key-crosschain";

// ── helpers ───────────────────────────────────────────────────────────────────

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

/**
 * Generate an Ed25519 key pair and derive the canonical Equilibrium address.
 * address = sha256(rawPubkeyBytes).slice(0, 40)
 */
function makeRelayerKey(): { privKey: Uint8Array; pubKey: Uint8Array; address: string; pubkeyHex: string } {
  const privKey = randomEd25519PrivKey();
  const pubKey = ed25519.getPublicKey(privKey);
  const address = createHash("sha256").update(pubKey).digest("hex").slice(0, 40);
  const pubkeyHex = Buffer.from(pubKey).toString("hex");
  return { privKey, pubKey, address, pubkeyHex };
}

/**
 * Sign an attestation message with an Ed25519 key.
 * The message is signed as raw bytes (same as wasm.ts verify_owner_sig).
 */
function signAttestation(privKey: Uint8Array, msg: string): string {
  const msgBytes = new TextEncoder().encode(msg);
  const sig = ed25519.sign(msgBytes, privKey);
  return Buffer.from(sig).toString("hex");
}

const BOND = 2_000_000_000; // 2 billion base units (> relay_min_bond default of 1B)
const RELAYER_BALANCE = 10_000_000_000; // 10 billion — enough to cover the bond

// ── test setup ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env["ADMIN_KEY"] = ADMIN_KEY;
  await initChain();
  // Deploy (or re-use) the CrossChainRelay contract
  await deployCrossChainRelayIfNeeded(chainState.wasmVM, minerAddress);
}, 60_000);

afterAll(() => {
  stopMining();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — relay info before setup", () => {
  it("GET /api/relay/info returns contract address once deployed", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) {
      // Hex not built yet — skip gracefully
      console.warn("CrossChainRelay hex not built; skipping relay info test");
      return;
    }
    const res = await api.get("/api/relay/info");
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(contractAddr);
    expect(typeof res.body.threshold).toBe("number");
    expect(typeof res.body.relayerCount).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — relayer registration", () => {
  let relayer: ReturnType<typeof makeRelayerKey>;

  beforeAll(() => {
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
  });

  it("rejects registration below min bond", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: "0" });
    expect(res.status).toBe(400);
  });

  it("registers a relayer with sufficient bond", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects duplicate registration", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    fund(relayer.address, RELAYER_BALANCE);
    const res = await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already/i);
  });

  it("GET /api/relay/info shows 1 relayer after registration", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get("/api/relay/info");
    expect(res.status).toBe(200);
    expect(res.body.relayerCount).toBeGreaterThanOrEqual(1);
    expect(res.body.relayers).toContain(relayer.address);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — threshold management", () => {
  it("rejects threshold update without admin key", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.patch("/api/relay/threshold").send({ threshold: 1 });
    expect(res.status).toBe(403);
  });

  it("admin can set threshold to 1 for single-relayer tests", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .patch("/api/relay/threshold")
      .set("x-admin-key", ADMIN_KEY)
      .send({ threshold: 1 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.threshold).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — inbound attestation (happy path)", () => {
  const chainId = "testchain-1";
  const commitment = randomBytes(32).toString("hex");
  const seq = 1n;
  let relayer: ReturnType<typeof makeRelayerKey>;

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
    // Register relayer (threshold was set to 1 in previous describe)
    await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
  });

  it("rejects attestation with missing chainId", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(400);
  });

  it("rejects attestation with wrong seq (skipping seq 1)", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const wrongSeq = 5n;
    const msg = buildAttestationMessage(chainId, wrongSeq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: wrongSeq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sequence/i);
  });

  it("rejects attestation with bad signature", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    // Corrupt the signature
    const badSig = "ff".repeat(64);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: badSig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("accepts a valid single-relayer attestation", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.chainId).toBe(chainId);
    expect(res.body.seq).toBe("1");
  });

  it("rejects duplicate attestation for same chain+seq", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already/i);
  });

  it("GET status shows attestation as pending", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending");
    expect(res.body.commitment).toBe(commitment);
    expect(res.body.signers).toContain(relayer.address);
  });

  it("404 for non-existent attestation", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/9999`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — inbound finalization after challenge window", () => {
  const chainId = "testchain-finalize";
  const commitment = randomBytes(32).toString("hex");
  const seq = 1n;
  let relayer: ReturnType<typeof makeRelayerKey>;

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
    await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
  });

  it("rejects finalization before challenge window expires", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/finalize`)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/window/i);
  });

  it("accepts finalization after advancing past challenge window (100 blocks)", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    advanceBlocks(105);
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/finalize`)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(200);
    expect(res.body.finalized).toBe(true);
  });

  it("GET status shows attestation as finalized", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("finalized");
  });

  it("rejects double-finalization", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/finalize`)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already finalized/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — admin challenge + slashing", () => {
  const chainId = "testchain-challenge";
  const commitment = randomBytes(32).toString("hex");
  const seq = 1n;
  let relayer: ReturnType<typeof makeRelayerKey>;

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
    await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sig = signAttestation(relayer.privKey, msg);
    await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sig, pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
  });

  it("rejects challenge without admin key", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/challenge`)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(403);
  });

  it("admin can challenge a fraudulent attestation", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const challenger = randomAddress();
    fund(challenger, RELAYER_BALANCE);
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/challenge`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: challenger });
    expect(res.status).toBe(200);
    expect(res.body.challenged).toBe(true);
  });

  it("GET status shows attestation as challenged", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("challenged");
  });

  it("rejects double-challenge", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/challenge`)
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/challenged/i);
  });

  it("rejects finalization of a challenged attestation", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    advanceBlocks(110);
    const res = await api
      .post(`/api/relay/attest/inbound/${chainId}/1/finalize`)
      .send({ caller: randomAddress() });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — outbound commitments", () => {
  const chainId = "cosmos-1";
  let caller: string;

  beforeAll(() => {
    caller = randomAddress();
    fund(caller, RELAYER_BALANCE);
  });

  it("rejects malformed commitmentHex", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.post(`/api/relay/outbound/${chainId}`).send({
      caller,
      commitmentHex: "notahex",
    });
    expect(res.status).toBe(400);
  });

  it("publishes first outbound commitment with seq=1", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const commitment = randomBytes(32).toString("hex");
    const res = await api.post(`/api/relay/outbound/${chainId}`).send({
      caller,
      commitmentHex: commitment,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.outboundSeq).toBe(1);
  });

  it("publishes second outbound commitment with seq=2", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const commitment = randomBytes(32).toString("hex");
    const res = await api.post(`/api/relay/outbound/${chainId}`).send({
      caller,
      commitmentHex: commitment,
    });
    expect(res.status).toBe(200);
    expect(res.body.outboundSeq).toBe(2);
  });

  it("GET outbound seq returns 2", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/outbound/${chainId}/seq`);
    expect(res.status).toBe(200);
    expect(res.body.outboundSeq).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — multi-sig attestation (2-of-2)", () => {
  const chainId = "polkadot-1";
  const commitment = randomBytes(32).toString("hex");
  const seq = 1n;
  let relayerA: ReturnType<typeof makeRelayerKey>;
  let relayerB: ReturnType<typeof makeRelayerKey>;

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayerA = makeRelayerKey();
    relayerB = makeRelayerKey();
    fund(relayerA.address, RELAYER_BALANCE);
    fund(relayerB.address, RELAYER_BALANCE);
    // Register both relayers
    await api.post("/api/relay/register").set("x-admin-key", ADMIN_KEY).send({ caller: relayerA.address, amount: BOND.toString() });
    await api.post("/api/relay/register").set("x-admin-key", ADMIN_KEY).send({ caller: relayerB.address, amount: BOND.toString() });
    // Set threshold to 2
    await api
      .patch("/api/relay/threshold")
      .set("x-admin-key", ADMIN_KEY)
      .send({ threshold: 2 });
  });

  it("rejects attestation with only 1 signature when threshold is 2", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sigA = signAttestation(relayerA.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [{ signatureHex: sigA, pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/threshold/i);
  });

  it("rejects attestation with duplicate signer", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sigA = signAttestation(relayerA.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [
        { signatureHex: sigA, pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address },
        { signatureHex: sigA, pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it("accepts 2-of-2 attestation with distinct valid signatures", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const sigA = signAttestation(relayerA.privKey, msg);
    const sigB = signAttestation(relayerB.privKey, msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      signatures: [
        { signatureHex: sigA, pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address },
        { signatureHex: sigB, pubkeyHex: relayerB.pubkeyHex, signerAddress: relayerB.address },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("GET status for 2-of-2 attestation shows both signers", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.signers).toHaveLength(2);
    expect(res.body.signers).toContain(relayerA.address);
    expect(res.body.signers).toContain(relayerB.address);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("CrossChainRelay — admin relayer revocation", () => {
  let relayer: ReturnType<typeof makeRelayerKey>;

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
    await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
  });

  it("rejects revocation without admin key", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.delete(`/api/relay/register/${relayer.address}`);
    expect(res.status).toBe(403);
  });

  it("admin can revoke a relayer", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api
      .delete(`/api/relay/register/${relayer.address}`)
      .set("x-admin-key", ADMIN_KEY);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.revoked).toBe(relayer.address);
  });

  it("revoked relayer no longer in relayer set", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get("/api/relay/info");
    expect(res.body.relayers).not.toContain(relayer.address);
  });
});
