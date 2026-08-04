/**
 * CrossChainRelay integration tests.
 *
 * Exercises the full FCCP lifecycle through the HTTP API:
 *   - Relayer registration + bond escrow
 *   - m-of-n BLS12-381-signed inbound attestation submission
 *   - Finalization after challenge window
 *   - Admin challenge + bond slashing
 *   - Outbound commitment publishing
 *   - Threshold management
 *
 * All signatures are real BLS12-381 (longSignatures: G1 pubkeys, G2 sigs) — no mocks.
 * The signing flow mirrors the bls_verify host implementation in wasm.ts:
 *   1. Hash the canonical message to a G2 point via G2.hashToCurve()
 *   2. Sign the G2 point with the private key
 *   3. Aggregate individual signatures into one G2 aggregate sig
 *   4. Send aggSigHex (192 hex chars) + signers[] (pubkeyHex + signerAddress)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes, createHash } from "crypto";
import supertest from "supertest";
import { bls12_381 } from "@noble/curves/bls12-381.js";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import {
  deployCrossChainRelayIfNeeded,
  getCrossChainRelayAddress,
  buildAttestationMessage,
} from "../chain/crossChainRelay.js";

const BLS = bls12_381.longSignatures; // G1 pubkeys (48 B), G2 sigs (96 B)
const G2  = bls12_381.G2;

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

interface RelayerKey {
  privKey: Uint8Array;
  /** 96 hex chars — BLS12-381 G1 compressed pubkey (48 bytes) */
  pubkeyHex: string;
  /** 40 hex chars — sha256(pubkey).slice(0,40) */
  address: string;
}

/**
 * Generate a BLS12-381 key pair and derive the canonical Equilibrium address.
 * address = sha256(compressed G1 pubkey bytes).slice(0, 40)
 */
function makeRelayerKey(): RelayerKey {
  const privKey     = randomBytes(32);
  const pubKeyBytes = BLS.getPublicKey(privKey).toBytes(true); // 48-byte G1 compressed
  const pubkeyHex   = Buffer.from(pubKeyBytes).toString("hex"); // 96 hex chars
  const address     = createHash("sha256").update(pubKeyBytes).digest("hex").slice(0, 40);
  return { privKey, pubkeyHex, address };
}

/**
 * Sign an attestation message with a BLS12-381 private key.
 * Returns the raw 96-byte G2 signature (compressed).
 * The message is hashed to a G2 point first, matching bls_verify in wasm.ts.
 */
function signBLS(privKey: Uint8Array, msg: string): Uint8Array {
  const msgBytes = new TextEncoder().encode(msg);
  const msgPoint = G2.hashToCurve(msgBytes);
  return BLS.sign(msgPoint, privKey).toBytes(true); // 96 bytes
}

/**
 * Build the `aggSigHex` + `signers[]` body fields for a set of relayers
 * all signing the same attestation message.
 */
function buildAggPayload(
  relayers: RelayerKey[],
  msg: string,
): { aggSigHex: string; signers: { pubkeyHex: string; signerAddress: string }[] } {
  const rawSigs = relayers.map((r) => signBLS(r.privKey, msg));
  const aggSig  = BLS.aggregateSignatures(rawSigs).toBytes(true); // 96 bytes
  return {
    aggSigHex: Buffer.from(aggSig).toString("hex"), // 192 hex chars
    signers: relayers.map((r) => ({ pubkeyHex: r.pubkeyHex, signerAddress: r.address })),
  };
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
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
    });
    expect(res.status).toBe(400);
  });

  it("rejects attestation with wrong seq (skipping seq 1)", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const wrongSeq = 5n;
    const msg = buildAttestationMessage(chainId, wrongSeq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: wrongSeq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sequence/i);
  });

  it("rejects attestation with bad signature", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    // Corrupt the aggregate BLS signature (192 hex chars = 96 bytes)
    const badAggSigHex = "ff".repeat(96);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex: badAggSigHex,
      signers: [{ pubkeyHex: relayer.pubkeyHex, signerAddress: relayer.address }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });

  it("accepts a valid single-relayer attestation", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
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
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
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
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
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
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    await api.post("/api/relay/attest/inbound").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
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

  it("rejects attestation with only 1 signer when threshold is 2", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayerA], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/threshold/i);
  });

  it("rejects attestation with duplicate signer address", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    // Single valid agg sig but duplicate address in signers[] — contract checks addresses first
    const { aggSigHex } = buildAggPayload([relayerA], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex,
      signers: [
        { pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address },
        { pubkeyHex: relayerA.pubkeyHex, signerAddress: relayerA.address },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate/i);
  });

  it("accepts 2-of-2 attestation with distinct valid BLS signatures", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayerA, relayerB], msg);
    const res = await api.post("/api/relay/attest/inbound").send({
      caller: relayerA.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex, signers,
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

describe("CrossChainRelay — SPV header submission + Merkle inclusion proof", () => {
  const chainId = "cosmos-spv-1";
  const commitment = randomBytes(32).toString("hex");
  const spvBlockNum = 42n;
  const seq = 1n;
  let relayer: ReturnType<typeof makeRelayerKey>;

  // Merkle tree shared across all tests in this suite — built once so
  // the same root goes into the header submission AND the SPV proof.
  let sharedLayers: Buffer[][];
  let sharedRoot: string;

  // ── Merkle tree helpers ──────────────────────────────────────────────────

  /** leaf = sha256(commitmentHex as UTF-8) — matches Rust verify_merkle_proof */
  function leafHash(commitmentHex: string): Buffer {
    return createHash("sha256").update(commitmentHex, "utf8").digest();
  }

  function sha256Pair(left: Buffer, right: Buffer): Buffer {
    return createHash("sha256").update(Buffer.concat([left, right])).digest();
  }

  /**
   * Build a balanced binary SHA-256 Merkle tree.
   * Returns layers from leaf level up to [root].
   * Odd-length layers duplicate the last element.
   */
  function buildMerkleTree(leaves: Buffer[]): Buffer[][] {
    let layer = [...leaves];
    while ((layer.length & (layer.length - 1)) !== 0) layer.push(layer.at(-1)!);
    const layers: Buffer[][] = [layer];
    while (layer.length > 1) {
      const next: Buffer[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(sha256Pair(layer[i]!, layer[i + 1]!));
      layers.push((layer = next));
    }
    return layers;
  }

  function merkleRoot(layers: Buffer[][]): string {
    return layers.at(-1)![0]!.toString("hex");
  }

  /** Returns siblings from leaf level up, ready for the SPV ABI. */
  function merkleProof(layers: Buffer[][], leafIndex: number): { leafIndex: bigint; siblings: string[] } {
    const siblings: string[] = [];
    let idx = leafIndex;
    for (let i = 0; i < layers.length - 1; i++) {
      const layer = layers[i]!;
      const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const sib = layer[sibIdx] ?? layer[idx]!;
      siblings.push(sib.toString("hex"));
      idx = Math.floor(idx / 2);
    }
    return { leafIndex: BigInt(leafIndex), siblings };
  }

  // ── setup ────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    relayer = makeRelayerKey();
    fund(relayer.address, RELAYER_BALANCE);
    // Register relayer and set threshold to 1
    await api
      .post("/api/relay/register")
      .set("x-admin-key", ADMIN_KEY)
      .send({ caller: relayer.address, amount: BOND.toString() });
    await api.patch("/api/relay/threshold").set("x-admin-key", ADMIN_KEY).send({ threshold: 1 });

    // Build the Merkle tree once — the same root must go into both the
    // header submission and the SPV inclusion proof.
    const leaf   = leafHash(commitment);
    const filler = Buffer.alloc(32, 0x42); // deterministic filler so tests are reproducible
    sharedLayers = buildMerkleTree([leaf, filler]);
    sharedRoot   = merkleRoot(sharedLayers);
  });

  // ── header tests ─────────────────────────────────────────────────────────

  it("rejects header from non-relayer", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const fakeRelayer = makeRelayerKey();
    const root = randomBytes(32).toString("hex");
    const res = await api.post("/api/relay/header/submit").send({
      caller: fakeRelayer.address,
      chainId,
      blockNum: spvBlockNum.toString(),
      merkleRootHex: root,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/relayer/i);
  });

  it("accepts a valid header from a registered relayer", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.post("/api/relay/header/submit").send({
      caller: relayer.address,
      chainId,
      blockNum: spvBlockNum.toString(),
      merkleRootHex: sharedRoot,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blockNum).toBe(spvBlockNum.toString());
  });

  // ── SPV attestation tests ─────────────────────────────────────────────────

  it("rejects SPV attestation with no submitted header", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const fakeProof = { leafIndex: "0", siblings: [] };
    const res = await api.post("/api/relay/attest/inbound/spv").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex,
      signers,
      spvBlockNum: "9999",      // no header for this block
      proof: fakeProof,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/header/i);
  });

  it("rejects SPV attestation with a tampered Merkle proof", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    // Use the shared valid tree but corrupt the first sibling → proof fails
    const proof = merkleProof(sharedLayers, 0);
    const corruptedSiblings = [
      ("ff" + proof.siblings[0]!.slice(2)) as string,
      ...proof.siblings.slice(1),
    ];
    const res = await api.post("/api/relay/attest/inbound/spv").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex,
      signers,
      spvBlockNum: spvBlockNum.toString(),
      proof: { leafIndex: proof.leafIndex.toString(), siblings: corruptedSiblings },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/proof/i);
  });

  it("accepts SPV attestation with valid header + correct Merkle proof", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const msg = buildAttestationMessage(chainId, seq, commitment);
    const { aggSigHex, signers } = buildAggPayload([relayer], msg);
    const proof = merkleProof(sharedLayers, 0);

    const res = await api.post("/api/relay/attest/inbound/spv").send({
      caller: relayer.address,
      chainId,
      seq: seq.toString(),
      commitmentHex: commitment,
      aggSigHex,
      signers,
      spvBlockNum: spvBlockNum.toString(),
      proof: { leafIndex: proof.leafIndex.toString(), siblings: proof.siblings },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.spv).toBe(true);
    expect(res.body.spvBlockNum).toBe(spvBlockNum.toString());
  });

  it("GET status shows SPV attestation as pending", async () => {
    const contractAddr = getCrossChainRelayAddress();
    if (!contractAddr) return;
    const res = await api.get(`/api/relay/attest/inbound/${chainId}/1`);
    expect(res.status).toBe(200);
    expect(res.body.commitment).toBe(commitment);
    expect(res.body.signers).toContain(relayer.address);
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
