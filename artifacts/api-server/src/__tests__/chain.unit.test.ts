import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hash256, sha256, merkleRoot, addressFromSeed, canonicalHeaderHash } from "../chain/crypto.js";
import { fpEncode, blockHashToFields } from "../chain/zk-encoding.js";
import { generateZkProof, verifyZkProof } from "../chain/zkproof.js";
import { ChainState, mineNextBlock } from "../chain/state.js";
import { admitResidual, canonicalResidual } from "../chain/canonical-residual.js";
import { rebuildStateSmt } from "../chain/state-root.js";
import { allowRandomMiningFallback, assertRandomMiningAllowed } from "../chain/mining-policy.js";
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

// ── mining-policy / mineNextBlock — B2 RNG gate ───────────────────────────────
//
// mineNextBlock() uses Math.random() and must be blocked in production so it
// can never silently emit a fake-residual block on a live network.

describe("mining-policy assertRandomMiningAllowed", () => {
  let savedNodeEnv: string | undefined;
  let savedAllowRandom: string | undefined;

  beforeEach(() => {
    savedNodeEnv     = process.env["NODE_ENV"];
    savedAllowRandom = process.env["ALLOW_RANDOM_MINING"];
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env["NODE_ENV"];
    else process.env["NODE_ENV"] = savedNodeEnv;

    if (savedAllowRandom === undefined) delete process.env["ALLOW_RANDOM_MINING"];
    else process.env["ALLOW_RANDOM_MINING"] = savedAllowRandom;
  });

  it("forbids RNG when ALLOW_RANDOM_MINING is unset (default-off policy)", () => {
    delete process.env["NODE_ENV"];
    delete process.env["ALLOW_RANDOM_MINING"];
    expect(() => assertRandomMiningAllowed("test")).toThrow(/RNG mining is forbidden/);
    expect(allowRandomMiningFallback()).toBe(false);
  });

  it("blocks RNG when NODE_ENV=production", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["ALLOW_RANDOM_MINING"];
    expect(() => assertRandomMiningAllowed("test")).toThrow(/RNG mining is forbidden/);
    expect(allowRandomMiningFallback()).toBe(false);
  });

  it("forbids RNG in any env when ALLOW_RANDOM_MINING is absent", () => {
    for (const env of ["development", "test", "staging", undefined]) {
      if (env === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = env;
      delete process.env["ALLOW_RANDOM_MINING"];
      expect(() => assertRandomMiningAllowed()).toThrow(/RNG mining is forbidden/);
    }
  });

  it("ALLOW_RANDOM_MINING=true enables RNG regardless of NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    process.env["ALLOW_RANDOM_MINING"] = "true";
    expect(() => assertRandomMiningAllowed("test")).not.toThrow();
    expect(allowRandomMiningFallback()).toBe(true);
  });

  it("mineNextBlock throws when ALLOW_RANDOM_MINING is unset", () => {
    delete process.env["NODE_ENV"];
    delete process.env["ALLOW_RANDOM_MINING"];
    const state = new ChainState();
    expect(() => mineNextBlock(state, "a".repeat(40))).toThrow(/RNG mining is forbidden/);
  });
});

// ── ChainState — UTXO fee collection ─────────────────────────────────────────
//
// UTXO transactions settle instantly (outside block assembly), so their fees
// accrue in `pendingUtxoFees` and must be swept to the miner of the next
// mined block instead of silently disappearing (burned).

describe("ChainState UTXO fee sweep", () => {
  const minerA = "a".repeat(40);
  const minerB = "b".repeat(40);

  it("credits accrued UTXO fees to the next block's miner as a UTXO output, and pays coinbase only on the account ledger", () => {
    const state = new ChainState();
    state.pendingUtxoFees = 1_500;

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA };
    state.addBlock(block);

    expect(state.pendingUtxoFees).toBe(0);
    expect(state.utxoSet.balance(minerA)).toBe(1_500);
    expect(state.ledger.balance(minerA)).toBe(block.coinbaseReward);
  });

  it("does not create a coinbase UTXO when no UTXO fees have accrued", () => {
    const state = new ChainState();

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA };
    state.addBlock(block);

    expect(state.utxoSet.balance(minerA)).toBe(0);
    expect(state.ledger.balance(minerA)).toBe(block.coinbaseReward);
  });

  it("restores the fee pool on rollback so it can be re-swept on the winning fork", () => {
    const state = new ChainState();
    state.pendingUtxoFees = 750;

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerB };
    state.addBlock(block);
    expect(state.pendingUtxoFees).toBe(0);
    expect(state.utxoSet.balance(minerB)).toBe(750);
    expect(state.ledger.balance(minerB)).toBe(block.coinbaseReward);

    state.rollbackToHeight(-1);

    expect(state.pendingUtxoFees).toBe(750);
    expect(state.utxoSet.balance(minerB)).toBe(0);
  });

  it("rollback puts the account coinbase and the transfer back", () => {
    const state = new ChainState();
    const alice = "c".repeat(40);
    const bob = "d".repeat(40);
    state.ledger.credit(alice, 5_000);
    const tx = {
      hash: "cd".repeat(32),
      from: alice,
      to: bob,
      amount: 1_000,
      fee: 10,
      nonce: 0,
      blockHash: null,
      blockHeight: null,
      timestamp: 1_700_000_000,
      status: "pending" as const,
    };
    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA, transactions: [tx], txCount: 1, coinbaseReward: 100 };
    state.addBlock(block);
    expect(state.ledger.balance(minerA)).toBe(110);
    expect(state.ledger.balance(alice)).toBe(3_990);
    expect(state.ledger.balance(bob)).toBe(1_000);

    state.rollbackToHeight(-1);
    expect(state.height).toBe(-1);
    expect(state.ledger.balance(minerA)).toBe(0);
    expect(state.ledger.balance(alice)).toBe(5_000);
    expect(state.ledger.balance(bob)).toBe(0);

    const again = { ...fakeBlock(0, 1_700_000_000), hash: "1".repeat(64), miner: minerA, coinbaseReward: 100 };
    state.addBlock(again);
    expect(state.ledger.balance(minerA)).toBe(100);
  });

  it("a swap that cannot pay does not debit, and a failed second hop keeps neither hop", () => {
    const state = new ChainState();
    const alice = "e".repeat(40);
    state.ledger.credit(alice, 1_000);
    state.dexPools.set("thin", {
      id: "thin",
      tokenA: "EQU",
      tokenB: "USDC",
      reserveA: 10,
      reserveB: 0,
      totalLiquidity: 0,
      fee: 0.003,
      volumeA: 0,
      volumeB: 0,
      txCount: 0,
      createdAt: 0,
    });
    expect(state.swap("thin", alice, "EQU", 100)).toBe("insufficient liquidity");
    expect(state.ledger.balance(alice)).toBe(1_000);

    state.dexPools.set("first", {
      id: "first",
      tokenA: "EQU",
      tokenB: "USDC",
      reserveA: 1_000_000,
      reserveB: 1_000_000,
      totalLiquidity: 0,
      fee: 0.003,
      volumeA: 0,
      volumeB: 0,
      txCount: 0,
      createdAt: 0,
    });
    state.dexPools.set("dead", {
      id: "dead",
      tokenA: "EQU",
      tokenB: "USDC",
      reserveA: 0,
      reserveB: 1_000_000,
      totalLiquidity: 0,
      fee: 0.003,
      volumeA: 0,
      volumeB: 0,
      txCount: 0,
      createdAt: 0,
    });
    const beforeA = state.dexPools.get("first")!.reserveA;
    const history = state.swapHistory.length;
    const out = state.applyMultiSwap(["first", "dead"], "EQU", 100, alice);
    expect(out).toBeNull();
    expect(state.ledger.balance(alice)).toBe(1_000);
    expect(state.dexPools.get("first")!.reserveA).toBe(beforeA);
    expect(state.dexPools.get("first")!.txCount).toBe(0);
    expect(state.swapHistory.length).toBe(history);
  });

  it("does not create a spendable output for a transfer the account ledger rejects", () => {
    const state = new ChainState();
    const alice = "c".repeat(40);
    const bob = "d".repeat(40);
    state.ledger.credit(alice, 1_500);
    const tx = {
      hash: "ab".repeat(32),
      from: alice,
      to: bob,
      amount: 10_000_000_001,
      fee: 0,
      nonce: 0,
      blockHash: null,
      blockHeight: null,
      timestamp: 1_700_000_000,
      status: "pending" as const,
    };
    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA, transactions: [tx], txCount: 1 };
    state.addBlock(block);

    expect(state.ledger.balance(alice)).toBe(1_500);
    expect(state.ledger.balance(bob)).toBe(0);
    expect(state.utxoSet.get(tx.hash, 0)).toBeUndefined();
    expect(state.txIndex.get(tx.hash)?.status).toBe("failed");
    expect(state.ledger.selectApplicable([tx])).toEqual([]);
  });

  it("a restart snapshot rebuilds the same state root, including pools and validators", () => {
    const state = new ChainState();
    const alice = "a".repeat(40);
    state.ledger.credit(alice, 4_000);
    state.dexPools.set("EQU-USDC", {
      id: "EQU-USDC",
      tokenA: "EQU",
      tokenB: "USDC",
      reserveA: 50_000,
      reserveB: 40_000,
      totalLiquidity: 1,
      fee: 0.003,
      volumeA: 0,
      volumeB: 0,
      txCount: 3,
      createdAt: 1,
    });
    state.validators.set(alice, {
      address: alice,
      moniker: "alice",
      bondedStake: 2_000,
      accumulatedRewards: 0,
      slashed: false,
      slashCount: 0,
      jailed: false,
      uptime: 1,
      blocksProposed: 0,
      blocksVoted: 0,
      commission: 0.1,
    });
    state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner: minerA, coinbaseReward: 100 });
    const snap = state.exportRestartSnapshot();
    const born = new ChainState();
    born.importRestartSnapshot(snap);
    expect(born.ledger.balance(minerA)).toBe(state.ledger.balance(minerA));
    expect(born.ledger.balance(alice)).toBe(state.ledger.balance(alice));
    expect(born.dexPools.get("EQU-USDC")?.reserveA).toBe(50_000);
    expect(born.validators.get(alice)?.bondedStake).toBe(2_000);
    expect(rebuildStateSmt(born).root()).toBe(rebuildStateSmt(state).root());
  });

  it("a claimed residual is refused unless it is the recomputed residual", () => {
    const header = {
      prevHash: "ab".repeat(32),
      merkleRoot: "0".repeat(64),
      timestamp: 1_700_000_000,
      nonce: 36,
      difficulty: 1_000_000,
    };
    const recomputed = canonicalResidual(header, [], { cumulativeWork: 1, mempoolPressure: 0 });
    expect(Number.isFinite(recomputed)).toBe(true);
    expect(admitResidual(1e-9, 1e-6).ok).toBe(false);
    expect(admitResidual(1e-6, 1e-6)).toEqual({ ok: true, residual: 1e-6 });
    expect(admitResidual(1e-6, 1).ok).toBe(false);
  });

  it("nonce 6 is the canonical residual the rust search admits", () => {
    const header = {
      prevHash: "00".repeat(32),
      merkleRoot: "00".repeat(32),
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: 1_000_000,
    };
    const admitted = canonicalResidual(header, [], { cumulativeWork: 1, mempoolPressure: 0 });
    const zero = canonicalResidual({ ...header, nonce: 0 }, [], { cumulativeWork: 1, mempoolPressure: 0 });
    expect(Math.abs(zero - 0.02519000125198503)).toBeLessThan(1e-12);
    expect(Math.abs(admitted - 0.0002011002025239986)).toBeLessThan(1e-12);
    expect(admitted).toBeLessThan(2e-3);
    expect(admitResidual(admitted, admitted).ok).toBe(true);
    expect(admitResidual(zero, admitted).ok).toBe(false);
  });

  it("the residual grid matches the rust canonical search", () => {
    const h = (over: Record<string, number>) => ({
      prevHash: "00".repeat(32),
      merkleRoot: "00".repeat(32),
      timestamp: 1_700_000_000,
      nonce: 0,
      difficulty: 1_000_000,
      ...over,
    });
    const rows: Array<[string, ReturnType<typeof h>, { hash: string; fee: number }[], { cumulativeWork: number; mempoolPressure: number }, number]> = [
      ["nonce0", h({ nonce: 0 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.02519000125198503],
      ["nonce1", h({ nonce: 1 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.09076955982638274],
      ["nonce1-100k", h({ nonce: 1, difficulty: 100_000 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.086836478057786756],
      ["nonce7", h({ nonce: 7 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.043329506709598564],
      ["work0", h({ nonce: 6 }), [], { cumulativeWork: 0, mempoolPressure: 0 }, 1.000201100202524],
      ["pressure", h({ nonce: 6 }), [], { cumulativeWork: 1, mempoolPressure: 1 }, 2.0002011002025242],
      ["ts0", h({ nonce: 6, timestamp: 0 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.16225219837223626],
      ["nonceHi", h({ nonce: 9007199254740991 }), [], { cumulativeWork: 1, mempoolPressure: 0 }, 0.098695867101580084],
      ["tx", h({ nonce: 6 }), [{ hash: "ab".repeat(32), fee: 1000 }], { cumulativeWork: 1, mempoolPressure: 0.5 }, 0.5191116242016731],
    ];
    for (const [name, header, txs, state, expected] of rows) {
      const got = canonicalResidual(header, txs, state);
      expect(Math.abs(got - expected), name).toBeLessThan(1e-12);
    }
  });

  it("a validator miner does not mint beside the coinbase", () => {
    const state = new ChainState();
    const miner = "b".repeat(40);
    const other = "c".repeat(40);
    const delegator = "d".repeat(40);
    const mk = (address: string) => ({
      address,
      moniker: address.slice(0, 4),
      bondedStake: 1_000,
      accumulatedRewards: 0,
      slashed: false,
      slashCount: 0,
      jailed: false,
      uptime: 1,
      blocksProposed: 0,
      blocksVoted: 0,
      commission: 0.1,
    });
    state.validators.set(miner, mk(miner));
    state.validators.set(other, mk(other));
    state.stakes.set(`${delegator}-${miner}`, {
      delegator,
      validator: miner,
      amount: 200,
      startHeight: 0,
      startTimestamp: 1,
      unbonding: false,
      rewardsEarned: 0,
    });
    state.ledger.credit(delegator, 50);
    const supply = () => state.ledger.balance(miner) + state.ledger.balance(other) + state.ledger.balance(delegator);
    const before = supply();
    state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner, coinbaseReward: 100 });
    expect(supply() - before).toBe(10);
    expect(state.ledger.balance(miner)).toBe(10);
    expect(state.ledger.balance(other)).toBe(0);
    expect(state.ledger.balance(delegator)).toBe(50);
    expect(state.validators.get(miner)?.accumulatedRewards).toBe(45);
    expect(state.validators.get(other)?.accumulatedRewards).toBe(45);
    expect((supply() - before) + 45 + 45).toBe(100);
  });

  it("the sealed block hash binds the nonce and matches the public kernel", () => {
    const seal = (nonce: number, credit = 0) => {
      const state = new ChainState();
      if (credit > 0) state.ledger.credit("e".repeat(40), credit);
      const block = {
        ...fakeBlock(0, 1_700_000_000),
        miner: "b".repeat(40),
        coinbaseReward: 0,
        nonce,
        residual: 1e-6,
        residualFp: 1_000_000_000_000,
        committedPressure: 0,
        sealIdentity: true,
      };
      state.addBlock(block);
      return block.hash;
    };
    const nonce1 = seal(1);
    expect(nonce1).not.toBe(seal(2));
    expect(seal(1)).toBe(nonce1);
    expect(seal(1, 5)).not.toBe(nonce1);
    expect(nonce1).not.toBe(hash256(`block-0-${"0".repeat(64)}-1700000000`));
    expect(canonicalHeaderHash({
      prevHash: "11".repeat(32),
      merkleRoot: "22".repeat(32),
      stateRoot: "33".repeat(32),
      timestamp: 1_700_000_000,
      nonce: 7,
      difficulty: 1_000_000,
      residualFp: 201_100_202_523_998,
      miner: "ab".repeat(20),
      height: 3,
      committedPressure: 0,
    })).toBe("836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306");
    const pressured = new ChainState();
    const hot = {
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      nonce: 1,
      residual: 1e-6,
      residualFp: 1_000_000_000_000,
      committedPressure: 1,
      sealIdentity: true,
    };
    pressured.addBlock(hot);
    expect(hot.hash).not.toBe(nonce1);
  });

  it("a sealed block still rolls the fee UTXO back", () => {
    const state = new ChainState();
    const miner = "b".repeat(40);
    state.pendingUtxoFees = 750;
    const block = {
      ...fakeBlock(0, 1_700_000_000),
      miner,
      coinbaseReward: 0,
      committedPressure: 0.25,
      sealIdentity: true,
    };
    state.addBlock(block);
    expect(block.hash).not.toBe(hash256(`block-0-${"0".repeat(64)}-1700000000`));
    expect(state.utxoSet.balance(miner)).toBe(750);
    expect(state.pendingUtxoFees).toBe(0);
    state.rollbackToHeight(-1);
    expect(state.pendingUtxoFees).toBe(750);
    expect(state.utxoSet.balance(miner)).toBe(0);
  });

  it("an evidence-bearing seal binds chain id, evidence root, and omega root", () => {
    const state = new ChainState();
    const block = {
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      nonce: 6,
      residual: 1e-6,
      residualFp: 1_000_000_000_000,
      committedPressure: 0,
      sealIdentity: true,
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
    };
    state.addBlock(block);
    const common = {
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      stateRoot: block.stateRoot!,
      timestamp: block.timestamp,
      nonce: block.nonce,
      difficulty: block.difficulty,
      residualFp: block.residualFp!,
      miner: block.miner,
      height: block.height,
      committedPressure: 0,
    };
    expect(block.hash).toBe(canonicalHeaderHash({ ...common, chainId: 1, evidenceRoot: "cd".repeat(32), omegaRoot: "ef".repeat(32) }));
    expect(block.hash).not.toBe(canonicalHeaderHash(common));
  });

  it("the kernel's evidence-bearing header is the same hash in this process", () => {
    expect(canonicalHeaderHash({
      prevHash: "0".repeat(64),
      merkleRoot: "0".repeat(64),
      stateRoot: "89c80f5eddc60e39b03437f5a46e9e81fb03d24fe10d1b35892e8beebe977884",
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: 1_000_000,
      residualFp: 201_100_202_523_998,
      miner: "a".repeat(40),
      height: 1,
      committedPressure: 0,
      chainId: 1,
      evidenceRoot: "b425e880a379ede65d894a3470544f23a1a5076e690e78968e3072d2f2ca7994",
      omegaRoot: "2777b2548cd75d2d9712b3d0983bc38420c0306b132d458083bcb5c844a59fbd",
    })).toBe("795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2");
  });

  it("a foreign tip moves the next difficulty by the kernel ratio, and the tip survives a snapshot", () => {
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    state.btcTipHash = "0".repeat(64);
    state.blocks.push(fakeBlock(0, 1_700_000_000));
    state.blocks.push(fakeBlock(1, 1_700_000_015));
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(995_000);

    const fast = new ChainState();
    fast.currentDifficulty = 1_000_000;
    fast.blocks.push(fakeBlock(0, 1_700_000_000));
    fast.blocks.push(fakeBlock(1, 1_700_000_014));
    fast.updateDifficulty();
    expect(fast.currentDifficulty).toBe(1_071_428);

    const snap = state.exportRestartSnapshot();
    const born = new ChainState();
    born.importRestartSnapshot(snap);
    expect(born.btcTipHash).toBe("0".repeat(64));
    born.currentDifficulty = 1_000_000;
    born.updateDifficulty();
    expect(born.currentDifficulty).toBe(995_000);
  });
});

describe("stratum admission", () => {
  it("does not ask the variational-ai CLI to decide a share", () => {
    const src = readFileSync(fileURLToPath(new URL("../lib/stratum-server.ts", import.meta.url)), "utf8");
    expect(src.includes("variational-ai-cli")).toBe(false);
    expect(src.includes("execFileSync")).toBe(false);
    expect(src.includes("VAI_CLI_PATH")).toBe(false);
    expect(src.includes("canonicalResidual")).toBe(true);
    expect(src.includes("admitResidual")).toBe(true);
  });
});
