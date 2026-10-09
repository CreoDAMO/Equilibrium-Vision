import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hash256, sha256, merkleRoot, addressFromSeed, canonicalHeaderHash } from "../chain/crypto.js";
import { fpEncode, blockHashToFields } from "../chain/zk-encoding.js";
import { generateZkProof, verifyZkProof } from "../chain/zkproof.js";
import { ChainState, mineNextBlock, buildGenesisChainFromDoc } from "../chain/state.js";
import { admitResidual, canonicalResidual, residualFingerprint } from "../chain/canonical-residual.js";
import { BTC_GENESIS_HEADER_HEX } from "../chain/btc-header.js";
import { nextFinalizedHeight } from "../chain/finality.js";
import { kernelParty, KERNEL_ALLOCATIONS, KERNEL_POOLS, KERNEL_VALIDATOR_LIQUID } from "../chain/kernel-genesis.js";
import { wasmLeafOf } from "../chain/wasm-leaf.js";
import { applySuccessor, adjustDifficulty, foreignDifficultyFactor, initialOmega } from "../../../../site/src/protocol/constitution.js";
import { ARBITRAGE_CODE } from "../../../../site/src/protocol/evidence.js";
import { callArbitrage } from "../../../../site/src/protocol/wasm-host.js";
import { ethKeygen, hashEthHeader, hexOf, signEthHeader } from "../../../../site/src/protocol/eth-light.js";
import { NETWORKS } from "../../../../site/src/protocol/networks.js";
import { canonicalCoinbase } from "@workspace/coinomics";
import { rebuildStateSmt } from "../chain/state-root.js";
import { allowRandomMiningFallback, assertRandomMiningAllowed } from "../chain/mining-policy.js";
import type { BlockRecord, ValidatorRecord } from "../chain/types.js";
import type { ContractRecord } from "../chain/wasm.js";
import { ed25519 } from "@noble/curves/ed25519.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fakeBlock(height: number, timestamp: number): BlockRecord {
  return {
    hash: `${"0".repeat(63 - String(height).length)}${height}`,
    height,
    prevHash: "1".repeat(64),
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

function validator(address: string): ValidatorRecord {
  return {
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
// A UTXO-model fee is credited on the account ledger. It is not a second output.

describe("ChainState UTXO fee sweep", () => {
  const minerA = "a".repeat(40);
  const minerB = "b".repeat(40);

  it("does not pay accrued UTXO fees from a block that is not the successor", () => {
    const state = new ChainState();
    state.pendingUtxoFees = 1_500;

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA };
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);

    expect(state.pendingUtxoFees).toBe(1_500);
    expect(state.utxoSet.balance(minerA)).toBe(0);
    expect(state.ledger.balance(minerA)).toBe(0);
    expect(state.blocks).toHaveLength(0);
  });

  it("does not pay a coinbase from a block that is not the successor", () => {
    const state = new ChainState();

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerA };
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);

    expect(state.utxoSet.balance(minerA)).toBe(0);
    expect(state.ledger.balance(minerA)).toBe(0);
    expect(state.blocks).toHaveLength(0);
  });

  it("a refused block leaves the fee pool where it was", () => {
    const state = new ChainState();
    state.pendingUtxoFees = 750;

    const block = { ...fakeBlock(0, 1_700_000_000), miner: minerB };
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(state.pendingUtxoFees).toBe(750);
    expect(state.utxoSet.balance(minerB)).toBe(0);
    expect(state.ledger.balance(minerB)).toBe(0);
    expect(state.blocks).toHaveLength(0);
  });

  it("a refused block does not move the transfer or the coinbase", () => {
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
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(state.height).toBe(-1);
    expect(state.ledger.balance(minerA)).toBe(0);
    expect(state.ledger.balance(alice)).toBe(5_000);
    expect(state.ledger.balance(bob)).toBe(0);
    expect(state.txIndex.has(tx.hash)).toBe(false);
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
    expect(state.swap("thin", alice, "EQU", 100)).toBe("a pool moves only inside the successor");
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
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);

    expect(state.ledger.balance(alice)).toBe(1_500);
    expect(state.ledger.balance(bob)).toBe(0);
    expect(state.utxoSet.get(tx.hash, 0)).toBeUndefined();
    expect(state.txIndex.has(tx.hash)).toBe(false);
    expect(state.blocks).toHaveLength(0);
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
    expect(() => state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner: minerA, coinbaseReward: 100 })).toThrow(/block is not the successor/);
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

  it("a block that is not the successor does not mint beside the coinbase", () => {
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
    expect(() => state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner, coinbaseReward: 100 })).toThrow(/block is not the successor/);
    expect(supply() - before).toBe(0);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.ledger.balance(other)).toBe(0);
    expect(state.ledger.balance(delegator)).toBe(50);
    expect(state.validators.get(miner)?.accumulatedRewards).toBe(0);
    expect(state.validators.get(other)?.accumulatedRewards).toBe(0);
    expect(state.blocks).toHaveLength(0);
    expect(state.canonicalBody.omega.height).toBe(-1);
  });

  it("a non-successor is not resealed, and the public kernel hash still binds the nonce", () => {
    const block = {
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      nonce: 1,
      residual: 1e-6,
      residualFp: 1_000_000_000_000,
      committedPressure: 0,
      sealIdentity: true,
    };
    const before = block.hash;
    expect(() => new ChainState().addBlock(block)).toThrow(/block is not the successor/);
    expect(block.hash).toBe(before);
    const otherNonce = { ...block, nonce: 2 };
    expect(() => new ChainState().addBlock(otherNonce)).toThrow(/block is not the successor/);
    expect(otherNonce.hash).toBe(before);
    expect(before).not.toBe(hash256(`block-0-${"0".repeat(64)}-1700000000`));
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
    const hot = {
      ...block,
      committedPressure: 1,
    };
    expect(() => new ChainState().addBlock(hot)).toThrow(/block is not the successor/);
    expect(hot.hash).toBe(before);
  });

  it("a non-successor does not sweep the fee UTXO", () => {
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
    const before = block.hash;
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(block.hash).toBe(before);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.utxoSet.balance(miner)).toBe(0);
    expect(state.pendingUtxoFees).toBe(750);
    expect(state.blocks).toHaveLength(0);
    state.rollbackToHeight(-1);
    expect(state.pendingUtxoFees).toBe(750);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.utxoSet.balance(miner)).toBe(0);
  });

  it("a non-successor does not bind an evidence header", () => {
    const canonical = "33".repeat(32);
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
      stateRoot: canonical,
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
    };
    const before = block.hash;
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(block.hash).toBe(before);
    expect(block.stateRoot).toBe(canonical);
    expect(block.operationalRoot).toBeUndefined();
    expect(block.chainId).toBe(1);
    expect(state.blocks).toHaveLength(0);
    expect(canonicalHeaderHash({
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      stateRoot: canonical,
      timestamp: block.timestamp,
      nonce: block.nonce,
      difficulty: block.difficulty,
      residualFp: block.residualFp!,
      miner: block.miner,
      height: block.height,
      committedPressure: 0,
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
    })).not.toBe(before);
  });

  it("evidence fields on a non-successor are not stripped into an operational header", () => {
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
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(block.chainId).toBe(1);
    expect(block.evidenceRoot).toBe("cd".repeat(32));
    expect(block.stateRoot).toBeUndefined();
    expect(block.operationalRoot).toBeUndefined();
    expect(state.blocks).toHaveLength(0);
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

  it("a verified bitcoin header moves difficulty, a bare hash does not, and an eth string does not", () => {
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    expect(state.admitBtcHeader("00".repeat(80))).toBeNull();
    expect(state.btcTipHash).toBeNull();
    const admitted = state.admitBtcHeader(BTC_GENESIS_HEADER_HEX);
    expect(admitted).toBe("6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000");
    state.ethTipHash = "ff".repeat(32);
    state.blocks.push(fakeBlock(0, 1_700_000_000));
    state.blocks.push(fakeBlock(1, 1_700_000_015));
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_000_000);

    const fast = new ChainState();
    fast.currentDifficulty = 1_000_000;
    fast.blocks.push(fakeBlock(0, 1_700_000_000));
    fast.blocks.push(fakeBlock(1, 1_700_000_014));
    fast.updateDifficulty();
    expect(fast.currentDifficulty).toBe(1_071_428);

    const snap = state.exportRestartSnapshot();
    const born = new ChainState();
    born.importRestartSnapshot(snap);
    expect(born.btcTipHash).toBe(admitted);
    born.currentDifficulty = 1_000_000;
    born.ethTipHash = "ff".repeat(32);
    born.updateDifficulty();
    expect(born.currentDifficulty).toBe(1_000_000);
  });

  it("contract storage on a non-successor does not reseal either header", () => {
    const stored: ContractRecord = {
      address: "aa".repeat(20),
      deployer: "b".repeat(40),
      bytecode: "00",
      bytecodeHash: "11".repeat(32),
      storage: { cell: "changed" },
      deployedAt: 1,
      callCount: 0,
      totalGasUsed: 0,
    };
    const evidence = {
      miner: "b".repeat(40),
      coinbaseReward: 0,
      nonce: 6,
      residual: 1e-6,
      residualFp: 1_000_000_000_000,
      committedPressure: 0,
      sealIdentity: true,
      stateRoot: "33".repeat(32),
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
    };
    const plain = new ChainState();
    const dirty = new ChainState();
    dirty.wasmVM.replaceContracts([stored]);
    const a = { ...fakeBlock(0, 1_700_000_000), ...evidence };
    const b = { ...fakeBlock(0, 1_700_000_000), ...evidence };
    expect(() => plain.addBlock(a)).toThrow(/block is not the successor/);
    expect(() => dirty.addBlock(b)).toThrow(/block is not the successor/);
    expect(a.hash).toBe(b.hash);
    expect(a.stateRoot).toBe(evidence.stateRoot);
    expect(b.stateRoot).toBe(evidence.stateRoot);
    expect(a.operationalRoot).toBeUndefined();
    expect(b.operationalRoot).toBeUndefined();
    expect(b.chainId).toBe(1);
    expect(dirty.wasmVM.listContracts()[0]?.storage.cell).toBe("changed");

    const nativeA = new ChainState();
    const nativeB = new ChainState();
    nativeB.wasmVM.replaceContracts([{ ...stored, storage: { cell: "other" } }]);
    const left = {
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      sealIdentity: true,
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
    };
    const right = { ...left };
    expect(() => nativeA.addBlock(left)).toThrow(/block is not the successor/);
    expect(() => nativeB.addBlock(right)).toThrow(/block is not the successor/);
    expect(left.hash).toBe(right.hash);
    expect(left.chainId).toBe(1);
    expect(right.chainId).toBe(1);
    expect(left.stateRoot).toBeUndefined();
    expect(right.operationalRoot).toBeUndefined();
    expect(nativeB.wasmVM.listContracts()[0]?.storage.cell).toBe("other");
  });

  it("a non-successor does not pay the coinbase or apply governance params", () => {
    const miner = "b".repeat(40);
    const other = "c".repeat(40);
    const run = (baseReward: number, miningThreshold: number) => {
      const state = new ChainState();
      state.governance.params.baseReward = baseReward;
      state.governance.params.miningThreshold = miningThreshold;
      state.currentDifficulty = 1_000_000;
      state.validators.set(miner, validator(miner));
      state.validators.set(other, validator(other));
      expect(() => state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner, coinbaseReward: 99, difficulty: 1_000_000 })).toThrow(/block is not the successor/);
      return {
        liquid: state.ledger.balance(miner),
        stakeA: state.validators.get(miner)?.accumulatedRewards,
        stakeB: state.validators.get(other)?.accumulatedRewards,
        difficulty: state.currentDifficulty,
        baseReward: state.governance.params.baseReward,
        miningThreshold: state.governance.params.miningThreshold,
        bond: state.validators.get(miner)?.bondedStake,
        height: state.canonicalBody.omega.height,
      };
    };
    const governed = run(50_000_000, 1e-8);
    const perturbed = run(1_000_000, 1e-4);
    expect(governed.liquid).toBe(0);
    expect(perturbed.liquid).toBe(0);
    expect(governed.stakeA).toBe(0);
    expect(perturbed.stakeA).toBe(0);
    expect(governed.stakeB).toBe(0);
    expect(perturbed.stakeB).toBe(0);
    expect(governed.difficulty).toBe(1_000_000);
    expect(perturbed.difficulty).toBe(1_000_000);
    expect(governed.bond).toBe(perturbed.bond);
    expect(governed.height).toBe(-1);
    expect(governed.baseReward).toBe(50_000_000);
    expect(perturbed.baseReward).toBe(1_000_000);
    expect(governed.miningThreshold).toBe(1e-8);
    expect(perturbed.miningThreshold).toBe(1e-4);
  });

  it("a non-successor does not advance finality or slash", () => {
    const state = new ChainState();
    const addrs = ["b", "c", "d"].map((ch) => ch.repeat(40));
    for (const address of addrs) {
      state.validators.set(address, validator(address));
      const secret = ed25519.utils.randomSecretKey();
      state.registerValidatorKey(address, Buffer.from(ed25519.getPublicKey(secret)).toString("hex"), Buffer.from(secret).toString("hex"));
    }
    const bonds = () => addrs.map((a) => state.validators.get(a)?.bondedStake);
    const uptimes = () => addrs.map((a) => state.validators.get(a)?.uptime);
    const voted = () => addrs.map((a) => state.validators.get(a)?.blocksVoted);
    const beforeBonds = bonds();
    const beforeUptime = uptimes();
    const beforeVoted = voted();

    expect(() => state.addBlock({ ...fakeBlock(0, 1_700_000_000), miner: addrs[0]! })).toThrow(/block is not the successor/);
    expect(state.finalizedHeight).toBe(-1);
    expect(state.blocks).toHaveLength(0);
    expect(state.finalityRounds.size).toBe(0);
    expect(state.slashEvents).toEqual([]);
    expect(bonds()).toEqual(beforeBonds);
    expect(uptimes()).toEqual(beforeUptime);
    expect(voted()).toEqual(beforeVoted);
    expect(nextFinalizedHeight(1, -1, 3_000, 3_000)).toBe(-1);
    expect(nextFinalizedHeight(2, -1, 3_000, 3_000)).toBe(0);
    expect(nextFinalizedHeight(3, -1, 3_000, 3_000)).toBe(1);
    expect(nextFinalizedHeight(3, -1, 2_000, 3_000)).toBe(1);
    expect(nextFinalizedHeight(3, -1, 1_000, 3_000)).toBe(-1);
    expect(nextFinalizedHeight(3, -1, 0, 0)).toBe(-1);

    const jailed = new ChainState();
    for (const address of addrs) jailed.validators.set(address, validator(address));
    jailed.validators.get(addrs[2]!)!.jailed = true;
    expect(() => jailed.addBlock({ ...fakeBlock(0, 1_700_000_000), miner: addrs[0]! })).toThrow(/block is not the successor/);
    expect(jailed.finalizedHeight).toBe(-1);
    expect(jailed.blocks).toHaveLength(0);
    expect(jailed.validators.get(addrs[2]!)!.jailed).toBe(true);
    expect(jailed.validators.get(addrs[1]!)!.slashed).toBe(false);
  });

  it("a genesis document with the seven kernel lines credits the kernel operating balances", () => {
    const state = buildGenesisChainFromDoc({
      chain_id: "equilibrium-1",
      timestamp: "2026-07-05T00:44:37.417Z",
      initial_supply: "100000000",
      allocations: KERNEL_ALLOCATIONS.map((line) => ({
        address: line.address,
        amount: String(line.amount),
        vesting: "none",
        category: "line",
      })),
      initial_validators: [],
      dex_pools: [],
      parameters: {
        target_block_time_ms: 15_000,
        residual_threshold: 8e-4,
        initial_difficulty: 1_000_000,
        slashing_double_sign_pct: 5,
        slashing_downtime_pct: 1,
        unbonding_period_blocks: 10,
        max_validators: 100,
        governance_quorum_pct: 67,
        governance_voting_period_blocks: 10,
      },
    });
    const party = kernelParty("mainnet");
    expect(state.ledger.balance(party.treasury)).toBe(8_000_000);
    expect(state.ledger.balance(party.miner)).toBe(1_500_000);
    expect(state.validators.get(party.miner)?.bondedStake).toBe(500_000);
    for (const address of party.activity) expect(state.ledger.balance(address)).toBe(1_500_000);
    for (const v of KERNEL_VALIDATOR_LIQUID) {
      expect(state.ledger.balance(v.address)).toBe(v.amount);
      expect(state.validators.get(v.address)?.bondedStake).toBe(v.amount);
      expect(state.validators.get(v.address)?.commission).toBe(0.1);
    }
    let supply = 0;
    for (const acc of state.ledger.getAllAccounts().values()) supply += acc.balance;
    expect(supply).toBe(114_000_000);
    expect(state.height).toBe(-1);
    expect(state.blocks).toEqual([]);
    expect(state.admissionTarget).toBe(8e-4);
    expect(state.finalizedHeight).toBe(-1);
    for (const pool of KERNEL_POOLS) {
      expect(state.dexPools.get(pool.id)?.reserveA).toBe(pool.reserveA);
      expect(state.dexPools.get(pool.id)?.reserveB).toBe(pool.reserveB);
      expect(state.dexPools.get(pool.id)?.fee).toBe(pool.fee);
      expect(state.dexPools.get(pool.id)?.txCount).toBe(0);
    }
  });

  it("contract storage does not write the kernel wasm map, and a supplied wasm list does not either", () => {
    const state = new ChainState();
    state.wasmVM.replaceContracts([{
      address: "aa".repeat(20),
      deployer: "b".repeat(40),
      bytecode: "00",
      bytecodeHash: "11".repeat(32),
      storage: { cell: "local" },
      deployedAt: 1,
      callCount: 0,
      totalGasUsed: 0,
    }]);
    expect(wasmLeafOf(state.canonicalWasm.entries())).toBe("none");
    const block = {
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      sealIdentity: true,
      stateRoot: "33".repeat(32),
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
      wasmEntries: [["cell", "from-call"]] as Array<[string, string]>,
    };
    expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
    expect(wasmLeafOf(state.canonicalWasm.entries())).toBe("none");
    expect(state.wasmVM.listContracts()[0]?.storage.cell).toBe("local");
    expect(block.stateRoot).toBe("33".repeat(32));
    expect(block.wasmEntries).toEqual([["cell", "from-call"]]);
    expect(state.blocks).toHaveLength(0);
  });

  it("a block field does not change couplings, and a passed kernel proposal does", () => {
    const state = new ChainState();
    state.governance.proposals.set("GOV-X", {
      id: "GOV-X",
      type: "parameter_change",
      title: "reward",
      description: "",
      proposer: "a".repeat(40),
      parameterChange: { key: "baseReward", value: 1_000_000 },
      submittedAt: 0,
      votingEndsAt: 0,
      readyToExecuteAt: 0,
      votesYes: 1,
      votesNo: 0,
      votesAbstain: 0,
      votes: new Map(),
      status: "passed",
    });
    state.governance.processBlock(1, 1_000);
    expect(state.governance.params.baseReward).toBe(50_000_000);
    expect(state.couplings.structural).toBe(1);
    const header = {
      prevHash: "0".repeat(64),
      merkleRoot: "0".repeat(64),
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: 1_000_000,
    };
    const before = canonicalResidual(header, [], { cumulativeWork: 1, mempoolPressure: 0 }, state.couplings);
    expect(() => state.addBlock({
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      stateRoot: "33".repeat(32),
      chainId: 1,
      evidenceRoot: "cd".repeat(32),
      omegaRoot: "ef".repeat(32),
      couplingKey: "structural",
      couplingValue: 0,
    })).toThrow(/block is not the successor/);
    expect(state.couplings.structural).toBe(1);
    state.kernelProposals.push({
      id: "k1",
      status: "passed",
      couplingKey: "structural",
      couplingValue: 0,
    });
    expect(() => state.addBlock({ ...fakeBlock(1, 1_700_000_015), miner: "b".repeat(40), coinbaseReward: 0 })).toThrow(/block is not the successor/);
    expect(state.kernelProposals[0]?.status).toBe("passed");
    expect(state.couplings.structural).toBe(1);
    expect(state.blocks).toHaveLength(0);
    const after = canonicalResidual(header, [], { cumulativeWork: 1, mempoolPressure: 0 }, state.couplings);
    expect(after).toBe(before);
    expect(residualFingerprint(after)).toBe(residualFingerprint(before));
  });

  it("the same inputs produce the same reward, split, difficulty, and finality on both bodies", () => {
    const state = buildGenesisChainFromDoc({
      chain_id: "equilibrium-1",
      timestamp: "2026-07-05T00:44:37.417Z",
      initial_supply: "100000000",
      allocations: KERNEL_ALLOCATIONS.map((line) => ({
        address: line.address,
        amount: String(line.amount),
        vesting: "none",
        category: "line",
      })),
      initial_validators: [],
      dex_pools: [],
      parameters: {
        target_block_time_ms: 15_000,
        residual_threshold: 8e-4,
        initial_difficulty: 1_000_000,
        slashing_double_sign_pct: 5,
        slashing_downtime_pct: 1,
        unbonding_period_blocks: 10,
        max_validators: 100,
        governance_quorum_pct: 67,
        governance_voting_period_blocks: 10,
      },
    });
    const omega = initialOmega("mainnet");
    const kernelBalances = new Map([...omega.ledger.entries()].map(([addr, acc]) => [addr, acc.balance]));
    for (const [addr, acc] of state.ledger.getAllAccounts()) {
      expect(kernelBalances.get(addr)).toBe(acc.balance);
      kernelBalances.delete(addr);
    }
    expect([...kernelBalances.keys()]).toEqual([]);
    expect(state.validators.size).toBe(omega.validators.size);
    for (const [addr, v] of omega.validators) {
      expect(state.validators.get(addr)?.bondedStake).toBe(v.bondedStake);
      expect(state.validators.get(addr)?.commission).toBe(v.commission);
    }
    for (const pool of omega.pools) {
      const got = state.dexPools.get(pool.id);
      expect(got?.reserveA).toBe(pool.reserveA);
      expect(got?.reserveB).toBe(pool.reserveB);
      expect(got?.txCount).toBe(pool.txCount);
      expect(got?.fee).toBe(pool.fee);
    }
    state.utxoSet.add({
      txHash: "ab".repeat(32),
      outputIndex: 0,
      address: "c".repeat(40),
      amount: 50,
      coinbase: false,
      blockHeight: 0,
      spent: false,
    });
    state.wasmVM.replaceContracts([{
      address: "aa".repeat(20),
      deployer: "b".repeat(40),
      bytecode: "00",
      bytecodeHash: "11".repeat(32),
      storage: { cell: "local" },
      deployedAt: 1,
      callCount: 0,
      totalGasUsed: 0,
    }]);
    const miner = kernelParty("mainnet").miner;
    let current = omega;
    const rewards: number[] = [];
    const liquids: number[] = [];
    const finals: number[] = [];
    let operationalDiffers = false;
    for (let step = 0; step < 3; step++) {
      const height = current.height + 1;
      const timestamp = 1_700_000_000 + step * 15;
      const stepped = applySuccessor(current, {
        transactions: [],
        evidence: undefined,
        timestamp,
        nonce: 6n,
        miner,
        committedPressure: 0,
        couplings: { ...current.couplings },
        difficulty: current.difficulty,
        wasmAfter: null,
      });
      expect(stepped.ok).toBe(true);
      if (!stepped.ok) return;
      const recomputed = canonicalResidual(
        {
          prevHash: current.tipHash,
          merkleRoot: "0".repeat(64),
          timestamp,
          nonce: 6,
          difficulty: current.difficulty,
        },
        [],
        { cumulativeWork: height, mempoolPressure: 0 },
        current.couplings,
      );
      expect(recomputed).toBe(stepped.residual);
      expect(canonicalCoinbase(height, recomputed, state.admissionTarget)).toBe(stepped.reward);
      const before = state.ledger.balance(miner);
      const omegaHeight = state.canonicalBody.omega.height;
      const blockCount = state.blocks.length;
      const block = {
        ...fakeBlock(height, timestamp),
        prevHash: current.tipHash,
        miner,
        nonce: 6,
        difficulty: current.difficulty,
        residual: stepped.residual,
        coinbaseReward: stepped.reward,
      };
      if (step === 0) {
        state.addBlock(block);
        expect(block.canonicalSuccessor).toBe(true);
        expect(state.ledger.balance(miner) - before).toBe(stepped.liquid);
        for (const [addr, v] of stepped.next.validators) {
          expect(state.validators.get(addr)?.accumulatedRewards).toBe(v.accumulatedRewards);
          expect(state.validators.get(addr)?.blocksProposed).toBe(v.blocksProposed);
          expect(state.validators.get(addr)?.bondedStake).toBe(v.bondedStake);
        }
        expect(state.currentDifficulty).toBe(stepped.next.difficulty);
        expect(state.finalizedHeight).toBe(stepped.next.finalizedHeight);
        expect(state.couplings).toEqual(stepped.next.couplings);
        expect(block.stateRoot).toBe(stepped.stateRoot);
        operationalDiffers = false;
      } else {
        expect(() => state.addBlock(block)).toThrow(/block is not the successor/);
        expect(state.ledger.balance(miner)).toBe(before);
        expect(state.blocks).toHaveLength(blockCount);
        expect(state.canonicalBody.omega.height).toBe(omegaHeight);
        expect(block.canonicalSuccessor).not.toBe(true);
      }
      rewards.push(stepped.reward);
      liquids.push(stepped.liquid);
      finals.push(stepped.next.finalizedHeight);
      current = stepped.next;
      current.tipHash = step === 0 ? "11".repeat(32) : "22".repeat(32);
    }
    const betweenMainnet = canonicalCoinbase(1, 1e-3, 8e-4);
    const betweenTestnet = canonicalCoinbase(1, 1e-3, 2e-3);
    expect(betweenMainnet).not.toBe(betweenTestnet);
    expect(wasmLeafOf(state.canonicalWasm.entries())).toBe("none");
    console.log(JSON.stringify({
      ok: true,
      rewards,
      liquids,
      finals,
      difficulty: state.currentDifficulty,
      operationalDiffers,
      betweenMainnet,
      betweenTestnet,
      supply: [...state.ledger.getAllAccounts().values()].reduce((s, a) => s + a.balance, 0),
    }));
  });

  it("both bodies store the wasm map the kernel call returned", async () => {
    const caller = "c".repeat(40);
    const storage = new Map<string, string>();
    const executed = await callArbitrage(0, new TextEncoder().encode(caller), {
      caller,
      storage,
      blockNumber: 0,
    });
    expect(executed.code).toBe(1);
    const wasmAfter = new Map(executed.storage);
    expect(wasmAfter.size).toBeGreaterThan(0);

    const born = initialOmega("mainnet");
    const stepped = applySuccessor(born, {
      transactions: [],
      evidence: {
        v: 1,
        chainId: born.chainId,
        wasmCode: ARBITRAGE_CODE,
        btc: [],
        eth: [],
        wasm: [{ method: "init", caller }],
        stake: [],
      },
      timestamp: 1_700_000_000,
      nonce: 6n,
      miner: kernelParty("mainnet").miner,
      committedPressure: 0,
      couplings: { ...born.couplings },
      difficulty: born.difficulty,
      wasmAfter,
    });
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    expect(wasmLeafOf(stepped.next.wasm.entries())).toBe(wasmLeafOf(wasmAfter.entries()));

    const state = new ChainState();
    const staged = await state.executeKernelWasm("init", caller);
    expect(staged.ok).toBe(true);
    expect(wasmLeafOf(staged.storage.entries())).toBe(wasmLeafOf(stepped.next.wasm.entries()));
    expect(wasmLeafOf(state.canonicalWasm.entries())).toBe("none");
    const committed = await state.canonicalBody.commit({
      transactions: [],
      evidence: {
        v: 1,
        chainId: born.chainId,
        wasmCode: ARBITRAGE_CODE,
        btc: [],
        eth: [],
        wasm: [{ method: "init", caller }],
        stake: [],
      },
      timestamp: 1_700_000_000,
      nonce: 6n,
      miner: kernelParty("mainnet").miner,
      committedPressure: 0,
      couplings: { ...born.couplings },
      difficulty: born.difficulty,
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(wasmLeafOf(committed.record.wasm)).toBe(wasmLeafOf(stepped.next.wasm.entries()));

    const wasmBefore = wasmLeafOf(state.canonicalBody.omega.wasm.entries());
    expect(() => state.addBlock({
      ...fakeBlock(0, 1_700_000_000),
      miner: "b".repeat(40),
      coinbaseReward: 0,
      wasmEntries: [["cell", "from-call"]],
    })).toThrow(/block is not the successor/);
    expect(wasmLeafOf(state.canonicalWasm.entries())).toBe("none");
    expect(state.canonicalWasm.get("cell")).toBeUndefined();
    expect(wasmLeafOf(state.canonicalBody.omega.wasm.entries())).toBe(wasmBefore);
    expect(wasmLeafOf(state.canonicalBody.omega.wasm.entries())).toBe(wasmLeafOf(stepped.next.wasm.entries()));
  });

  it("an ethereum header is admitted only by the bls predicate", () => {
    const key = ethKeygen();
    const pubkey = hexOf(key.pubkey);
    const fields = {
      slot: 7,
      proposerIndex: 3,
      parentRoot: "11".repeat(32),
      stateRoot: "22".repeat(32),
      bodyRoot: "33".repeat(32),
    };
    const signature = hexOf(signEthHeader(key.secret, fields));
    const state = new ChainState();
    state.currentDifficulty = 1_000_000;
    state.blocks.push(fakeBlock(0, 1_700_000_000));
    state.blocks.push(fakeBlock(1, 1_700_000_015));
    state.ethTipHash = "ff".repeat(32);
    expect(state.admitEthHeader({
      pubkeyHex: pubkey,
      ...fields,
      participants: 341,
      signatureHex: signature,
    })).toBeNull();
    expect(state.admitEthHeader({
      pubkeyHex: pubkey,
      ...fields,
      participants: 342,
      signatureHex: "00".repeat(96),
    })).toBeNull();
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_000_000);
    expect(state.admittedEthTip).toBeNull();

    const hash = state.admitEthHeader({
      pubkeyHex: pubkey,
      ...fields,
      participants: 342,
      signatureHex: signature,
    });
    expect(hash).toBe(hexOf(hashEthHeader(fields)));
    state.currentDifficulty = 1_000_000;
    state.updateDifficulty();
    expect(state.currentDifficulty).toBe(1_000_000);
    const factor = foreignDifficultyFactor({
      btc: [],
      eth: [{
        slot: fields.slot,
        hash: hash!,
        parentRoot: fields.parentRoot,
        stateRoot: fields.stateRoot,
        bodyRoot: fields.bodyRoot,
        participants: 342,
      }],
    });
    const born = initialOmega("mainnet");
    expect(state.currentDifficulty).toBe(adjustDifficulty(1_000_000, 15, NETWORKS.mainnet, factor));
    const stepped = applySuccessor(born, {
      transactions: [],
      evidence: {
        v: 1,
        chainId: born.chainId,
        wasmCode: ARBITRAGE_CODE,
        btc: [],
        eth: [
          { op: "bootstrap", pubkey },
          { op: "header", ...fields, participants: 342, signature },
        ],
        wasm: [],
        stake: [],
      },
      timestamp: 1_700_000_000,
      nonce: 6n,
      miner: kernelParty("mainnet").miner,
      committedPressure: 0,
      couplings: { ...born.couplings },
      difficulty: born.difficulty,
      wasmAfter: null,
    });
    expect(stepped.ok).toBe(true);
    if (!stepped.ok) return;
    expect(stepped.next.eth.at(-1)?.hash).toBe(hash);
    expect(stepped.next.difficulty).toBe(adjustDifficulty(born.difficulty, 15, NETWORKS.mainnet, factor));
    expect(state.currentDifficulty).not.toBe(stepped.next.difficulty);
  });

  it("an explicit slash does not move a validator", () => {
    const state = new ChainState();
    const addr = "b".repeat(40);
    state.validators.set(addr, validator(addr));
    const before = state.validators.get(addr)!.bondedStake;
    const refused = state.slashValidator(addr, "double_sign", 1, 1_700_000_000);
    expect(refused.ok).toBe(false);
    expect(state.validators.get(addr)!.bondedStake).toBe(before);
    expect(state.validators.get(addr)!.slashed).toBe(false);
    expect(state.slashEvents).toEqual([]);
  });

  it("addBlock refuses slash evidence instead of ignoring it", () => {
    const state = new ChainState();
    const addr = "b".repeat(40);
    state.validators.set(addr, validator(addr));
    expect(() => state.addBlock({
      ...fakeBlock(0, 1_700_000_000),
      evidence: {
        v: 1,
        chainId: 1,
        wasmCode: "ab",
        btc: [],
        eth: [],
        wasm: [],
        stake: [{ op: "slash", validator: addr, reason: "double_sign" }],
      },
    })).toThrow(/successor/);
    expect(state.blocks).toHaveLength(0);
    expect(state.validators.get(addr)!.slashed).toBe(false);
    expect(state.validators.get(addr)!.bondedStake).toBe(validator(addr).bondedStake);
  });

  it("a local stake or unstake does not move a bond", () => {
    const state = new ChainState();
    const delegator = "a".repeat(40);
    const addr = "b".repeat(40);
    state.ledger.credit(delegator, 10_000);
    state.validators.set(addr, validator(addr));
    const before = state.validators.get(addr)!.bondedStake;
    expect(state.stake(delegator, addr, 100, 1)).toMatch(/successor/);
    expect(state.unstake(delegator, addr, 100, 1)).toMatch(/successor/);
    expect(state.ledger.balance(delegator)).toBe(10_000);
    expect(state.validators.get(addr)!.bondedStake).toBe(before);
    expect(state.stakes.size).toBe(0);
  });
});

describe("a retained non-successor is not the producer parent", () => {
  it("admits the next Ω successor after the record, and the record is not the tip", () => {
    const state = buildGenesisChainFromDoc({
      chain_id: "equilibrium-1",
      timestamp: "2026-07-05T00:44:37.417Z",
      initial_supply: "100000000",
      allocations: KERNEL_ALLOCATIONS.map((line) => ({
        address: line.address,
        amount: String(line.amount),
        vesting: "none",
        category: "line",
      })),
      initial_validators: [],
      dex_pools: [],
      parameters: {
        target_block_time_ms: 15_000,
        residual_threshold: 8e-4,
        initial_difficulty: 1_000_000,
        slashing_double_sign_pct: 5,
        slashing_downtime_pct: 1,
        unbonding_period_blocks: 10,
        max_validators: 100,
        governance_quorum_pct: 67,
        governance_voting_period_blocks: 10,
      },
    });
    const omega = state.canonicalBody.omega;
    const miner = kernelParty("mainnet").miner;
    state.recordUnexecuted({
      ...fakeBlock(9, 9_000_000_000),
      hash: "cd".repeat(32),
      prevHash: "1".repeat(64),
    });
    state.addBlock({
      ...fakeBlock(omega.height + 1, 1_700_000_000),
      prevHash: omega.tipHash,
      miner,
      nonce: 6,
      difficulty: omega.difficulty,
      committedPressure: 0,
    });
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.canonicalSuccessor).toBe(true);
    expect(state.blocks[0]?.hash).toBe(state.canonicalBody.omega.tipHash);
    expect(state.canonicalTip?.hash).toBe(state.canonicalBody.omega.tipHash);
    expect(state.latestBlock?.hash).not.toBe("cd".repeat(32));
    expect(state.retainedBlocks.map((block) => block.hash)).toEqual(["cd".repeat(32)]);
    expect(state.canonicalWork().prevHash).toBe(state.canonicalTip?.hash);
    expect(state.ledger.balance(miner)).toBe(state.canonicalBody.omega.ledger.get(miner)?.balance);
    expect(state.canonicalBody.omega.height).toBe(0);
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

  it("the block transition does not mint a coinbase UTXO", () => {
    const src = readFileSync(fileURLToPath(new URL("../chain/state.ts", import.meta.url)), "utf8");
    expect(src.includes("addCoinbase")).toBe(false);
    expect(src.includes("ed25519")).toBe(false);
    expect(src.includes("this.slashValidator")).toBe(false);
    expect(src.includes("slashValidator(")).toBe(true);
    expect(src.includes("block.wasmEntries")).toBe(false);
    expect(src.includes("block.couplingKey")).toBe(false);
    expect(src.includes("applyPassedCouplings")).toBe(true);
  });

  it("a gossiped body is not paid the governance base reward", () => {
    const src = readFileSync(fileURLToPath(new URL("../chain/index.ts", import.meta.url)), "utf8");
    expect(src.includes("coinbaseReward: 50_000_000")).toBe(false);
    expect(src.includes("admitResidual")).toBe(true);
    expect(src.includes("canonicalCoinbase(height, admission.residual")).toBe(true);
    expect(src.includes("canonicalCoinbase(height, residual)")).toBe(false);
  });
});
