import { describe, it, expect } from "vitest";
import { hash256, sha256, merkleRoot, addressFromSeed } from "../chain/crypto.js";
import { fpEncode, blockHashToFields } from "../chain/zk-encoding.js";
import { generateZkProof, verifyZkProof } from "../chain/zkproof.js";
import { ChainState } from "../chain/state.js";
import type { BlockRecord } from "../chain/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeBlock(height: number, timestamp: number): BlockRecord {
  return {
    hash: `${"0".repeat(63 - String(height).length)}${height}`,
    height,
    prevHash: "0".repeat(64),
    merkleRoot: "0".repeat(64),
    timestamp,
    nonce: 0,
    difficulty: 1_000_000,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 50_000_000,
    miner: "a".repeat(40),
    txCount: 0,
    transactions: [],
    finalized: false,
  };
}

// ── crypto.ts — hash256 ───────────────────────────────────────────────────────

describe("hash256", () => {
  it("returns a 64-char lowercase hex string", () => {
    const h = hash256("hello");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hash256("equilibrium")).toBe(hash256("equilibrium"));
  });

  it("is a double-SHA256 — differs from a single SHA256", () => {
    expect(hash256("test")).not.toBe(sha256("test"));
  });

  it("avalanches — different inputs produce different outputs", () => {
    expect(hash256("block-1")).not.toBe(hash256("block-2"));
  });
});

// ── crypto.ts — merkleRoot ────────────────────────────────────────────────────

describe("merkleRoot", () => {
  it("returns 64 zeros for an empty list", () => {
    expect(merkleRoot([])).toBe("0".repeat(64));
  });

  it("returns the single hash unchanged", () => {
    const h = hash256("only");
    expect(merkleRoot([h])).toBe(h);
  });

  it("hashes a two-element list as hash256(a + b)", () => {
    const a = hash256("tx-a");
    const b = hash256("tx-b");
    expect(merkleRoot([a, b])).toBe(hash256(a + b));
  });

  it("duplicates the last element for an odd-length list", () => {
    const a = hash256("a");
    const b = hash256("b");
    const c = hash256("c");
    // [a, b, c] → pad to [a, b, c, c] → [hash(a+b), hash(c+c)] → hash(left+right)
    const left = hash256(a + b);
    const right = hash256(c + c);
    expect(merkleRoot([a, b, c])).toBe(hash256(left + right));
  });

  it("produces consistent results for a four-element list", () => {
    const txs = ["tx1", "tx2", "tx3", "tx4"].map(hash256);
    const l = hash256(txs[0]! + txs[1]!);
    const r = hash256(txs[2]! + txs[3]!);
    expect(merkleRoot(txs)).toBe(hash256(l + r));
  });
});

// ── crypto.ts — addressFromSeed ───────────────────────────────────────────────

describe("addressFromSeed", () => {
  it("returns a 40-char lowercase hex string", () => {
    const addr = addressFromSeed("alice");
    expect(addr).toHaveLength(40);
    expect(addr).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is deterministic", () => {
    expect(addressFromSeed("alice")).toBe(addressFromSeed("alice"));
  });

  it("different seeds produce different addresses", () => {
    expect(addressFromSeed("alice")).not.toBe(addressFromSeed("bob"));
  });

  it("is the first 40 chars of sha256(seed)", () => {
    const seed = "carol";
    expect(addressFromSeed(seed)).toBe(sha256(seed).slice(0, 40));
  });
});

// ── zk-encoding.ts — fpEncode ────────────────────────────────────────────────

describe("fpEncode", () => {
  it("encodes zero as '0'", () => {
    expect(fpEncode(0)).toBe("0");
  });

  it("uses Math.floor — not Math.round", () => {
    // 1.5e-18 × 1e18 = 1.5  →  floor = 1, round = 2
    expect(fpEncode(1.5e-18)).toBe("1");
  });

  it("encodes the default threshold 1e-7 as 100000000000", () => {
    // floor(1e-7 × 1e18) = floor(100_000_000_000) = 100_000_000_000
    expect(fpEncode(1e-7)).toBe("100000000000");
  });

  it("returns a decimal string consistent with BigInt conversion", () => {
    const val = 5.3e-9;
    const enc = fpEncode(val);
    expect(BigInt(enc)).toBe(BigInt(Math.floor(val * 1e18)));
  });

  it("result is within the BN254 scalar field", () => {
    const Fr_MOD =
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const enc = BigInt(fpEncode(1e-7));
    expect(enc >= 0n && enc < Fr_MOD).toBe(true);
  });
});

// ── zk-encoding.ts — blockHashToFields ───────────────────────────────────────

describe("blockHashToFields", () => {
  const HASH = "aabbccdd11223344aabbccdd11223344" + "0".repeat(32);

  it("returns two decimal strings parseable as BigInt", () => {
    const { blockHashLow, blockHashHigh } = blockHashToFields(HASH);
    expect(() => BigInt(blockHashLow)).not.toThrow();
    expect(() => BigInt(blockHashHigh)).not.toThrow();
  });

  it("blockHashHigh is '0' — the input fits in 128 bits", () => {
    // Function takes first 32 hex chars = 16 bytes = 128-bit integer.
    // >> 128 on a 128-bit value = 0.
    const { blockHashHigh } = blockHashToFields(HASH);
    expect(blockHashHigh).toBe("0");
  });

  it("blockHashLow matches the expected BigInt value", () => {
    const { blockHashLow } = blockHashToFields(HASH);
    const expected = BigInt("0x" + HASH.slice(0, 32)).toString(10);
    expect(blockHashLow).toBe(expected);
  });

  it("strips a leading 0x prefix correctly", () => {
    const withPrefix = blockHashToFields("0x" + HASH);
    const withoutPrefix = blockHashToFields(HASH);
    expect(withPrefix.blockHashLow).toBe(withoutPrefix.blockHashLow);
    expect(withPrefix.blockHashHigh).toBe(withoutPrefix.blockHashHigh);
  });

  it("different hashes produce different low fields", () => {
    const f1 = blockHashToFields(hash256("block-A") + "0".repeat(32));
    const f2 = blockHashToFields(hash256("block-B") + "0".repeat(32));
    expect(f1.blockHashLow).not.toBe(f2.blockHashLow);
  });
});

// ── zkproof.ts — generate / verify ───────────────────────────────────────────

describe("generateZkProof / verifyZkProof", () => {
  const BLOCK_HASH = hash256("test-block-for-zk");

  it("marks proof valid when residual < threshold (1e-7)", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(proof.valid).toBe(true);
  });

  it("marks proof invalid when residual >= threshold", () => {
    const proof = generateZkProof(1e-5, BLOCK_HASH, 1);
    expect(proof.valid).toBe(false);
  });

  it("carries the correct circuitId", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(proof.circuitId).toBe("stationarity-v2-groth16-bn254");
  });

  it("vkHash is a 64-char hex string", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(proof.vkHash).toHaveLength(64);
    expect(proof.vkHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("proof contains non-zero G1 point coordinates", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(proof.proof.pi_a.x).not.toBe("0");
    expect(proof.proof.pi_a.y).not.toBe("0");
    expect(proof.proof.pi_c.x).not.toBe("0");
    expect(proof.proof.pi_c.y).not.toBe("0");
  });

  it("verifyZkProof accepts a freshly generated valid proof", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(verifyZkProof(proof)).toBe(true);
  });

  it("verifyZkProof rejects proof with tampered residual (above threshold)", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    const tampered = {
      ...proof,
      publicInputs: {
        ...proof.publicInputs,
        residual: "999999999999999999",
      },
    };
    expect(verifyZkProof(tampered)).toBe(false);
  });

  it("verifyZkProof rejects proof with wrong vkHash", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(verifyZkProof({ ...proof, vkHash: "0".repeat(64) })).toBe(false);
  });

  it("verifyZkProof rejects proof with wrong circuitId", () => {
    const proof = generateZkProof(1e-9, BLOCK_HASH, 1);
    expect(verifyZkProof({ ...proof, circuitId: "wrong-circuit" })).toBe(false);
  });

  it("different blocks produce different proof point coordinates", () => {
    const p1 = generateZkProof(1e-9, hash256("block-A"), 1);
    const p2 = generateZkProof(1e-9, hash256("block-B"), 1);
    expect(p1.proof.pi_a.x).not.toBe(p2.proof.pi_a.x);
  });
});

// ── ChainState — adaptive difficulty ─────────────────────────────────────────

describe("ChainState.updateDifficulty", () => {
  const TARGET_BLOCK_TIME = 15;

  it("clamps up to +20% when block time is much faster than target", () => {
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    // 6 blocks 1 second apart → avgBlockTime ≈ 1s → ratio 15/1 = 15, capped 1.20
    const now = 1_700_000_000;
    for (let i = 0; i <= 5; i++) state.blocks.push(fakeBlock(i, now + i));
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_200_000);
  });

  it("clamps down to -20% when block time is much slower than target", () => {
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    // 6 blocks 100 seconds apart → ratio 15/100 = 0.15, capped 0.80
    const now = 1_700_000_000;
    for (let i = 0; i <= 5; i++) state.blocks.push(fakeBlock(i, now + i * 100));
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(800_000);
  });

  it("makes no change when avg block time exactly equals target", () => {
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    const now = 1_700_000_000;
    for (let i = 0; i <= 5; i++) {
      state.blocks.push(fakeBlock(i, now + i * TARGET_BLOCK_TIME));
    }
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_000_000);
  });

  it("never drops below minimum difficulty (100 000)", () => {
    const state = new ChainState();
    state.currentDifficulty = 120_000; // 120_000 × 0.80 = 96_000 → floored to 100_000
    const now = 1_700_000_000;
    for (let i = 0; i <= 5; i++) state.blocks.push(fakeBlock(i, now + i * 100));
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(100_000);
  });

  it("keeps difficulty unchanged when there are no blocks (returns target avg)", () => {
    // avgBlockTime returns TARGET_BLOCK_TIME when blocks.length < 2, so ratio = 1.0
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_000_000);
  });
});
