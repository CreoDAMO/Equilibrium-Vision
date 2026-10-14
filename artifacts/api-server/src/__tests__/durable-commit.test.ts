/**
 * Durable admission. These run against the process, not a source trace.
 * A failed write must not delete a later block. A stale evidence successor
 * must not overwrite a newer one. persistBlock must name what the database did.
 */
import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { ChainState, buildGenesisChainFromDoc } from "../chain/state.js";
import { CanonicalBody } from "../chain/canonical-body.js";
import { kernelParty, KERNEL_ALLOCATIONS } from "../chain/kernel-genesis.js";
import { persistBlock, persistBlockUsing, deletePrunedBlockRows, deleteAbandonedBlockRows, type PersistBlockResult } from "../chain/persistence.js";
import { operationalReplaySet } from "../chain/restart-boundary.js";
import { blocksTable } from "../../../../lib/db/src/schema/blocks.ts";
import { transactionsTable } from "../../../../lib/db/src/schema/transactions.ts";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { minerKey } from "../../../../site/src/protocol/genesis.js";
import type { BlockRecord } from "../chain/types.js";
import type { Omega } from "../../../../site/src/protocol/constitution.js";

const miner = kernelParty("mainnet").miner;

function genesis(): ChainState {
  return buildGenesisChainFromDoc({
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
}

function candidate(state: ChainState, nonce: number, timestamp: number): BlockRecord {
  const omega = state.canonicalBody.omega;
  return {
    hash: "11".repeat(32),
    height: omega.height + 1,
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    timestamp,
    nonce,
    difficulty: omega.difficulty,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    txCount: 0,
    transactions: [],
    committedPressure: 0,
  };
}

function observe(state: ChainState) {
  const omega = state.canonicalBody.omega;
  return {
    tip: omega.tipHash,
    height: omega.height,
    finality: state.finalizedHeight,
    difficulty: omega.difficulty,
    blocks: state.blocks.map((block) => block.hash),
    operationalHeight: state.height,
    utxos: state.utxoSet.getAllUnspent().length,
    txs: state.txIndex.size,
    wasm: state.canonicalWasm.size,
    pools: [...state.dexPools.values()].map((pool) => [pool.id, pool.reserveA, pool.reserveB]),
    bonds: [...state.validators.values()].map((validator) => [validator.address, validator.bondedStake, validator.jailed, validator.slashed]),
    miner: state.ledger.balance(miner),
  };
}

function hold() {
  let entered = false;
  let release: (result: PersistBlockResult) => void = () => {};
  const promise = new Promise<PersistBlockResult>((resolve) => {
    release = resolve;
  });
  return {
    entered: () => entered,
    persist: () => {
      entered = true;
      return promise;
    },
    release,
  };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !pred(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!pred()) throw new Error("timed out waiting for the admission");
}

const inserted: PersistBlockResult = { durable: true, outcome: "inserted" };
const failed: PersistBlockResult = { durable: false, outcome: "failed" };

describe("a failed write does not remove a block that waited", () => {
  it("holds the next admission until the first write settles, then revalidates it", async () => {
    const state = genesis();
    const before = observe(state);
    const blockA = candidate(state, 6, 1_700_000_000);
    const gate = hold();
    const published: string[] = [];
    const pendingA = state.commitOperational(blockA, { persist: gate.persist });
    await until(gate.entered);
    expect(state.blocks).toHaveLength(1);
    expect(state.canonicalBody.omega.tipHash).not.toBe(before.tip);

    const blockB = candidate(state, 7, 1_700_000_012);
    const pendingB = state.commitOperational(blockB, {
      persist: async () => inserted,
    });
    await until(() => pendingB !== undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(observe(state).blocks).toEqual([blockA.hash]);

    gate.release(failed);
    const resultA = await pendingA;
    const resultB = await pendingB;
    if (resultA.kept) published.push("A");
    if (resultB.kept) published.push("B");

    expect(resultA.kept).toBe(false);
    expect(resultA.persist).toEqual(failed);
    expect(resultB.admitted).toBe(false);
    expect(resultB.kept).toBe(false);
    expect(published).toEqual([]);
    expect(observe(state)).toEqual(before);
  });

  it("admits the waiting sibling after the failed block is gone", async () => {
    const state = genesis();
    const before = observe(state);
    const blockA = candidate(state, 6, 1_700_000_000);
    const blockB = candidate(state, 8, 1_700_000_000);
    const gate = hold();
    const published: string[] = [];
    const pendingA = state.commitOperational(blockA, { persist: gate.persist });
    await until(gate.entered);
    const pendingB = state.commitOperational(blockB, { persist: async () => inserted });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.blocks.map((block) => block.hash)).toEqual([blockA.hash]);

    gate.release(failed);
    const resultA = await pendingA;
    const resultB = await pendingB;
    if (resultA.kept) published.push("A");
    if (resultB.kept) published.push("B");

    expect(resultA.kept).toBe(false);
    expect(resultB.admitted).toBe(true);
    expect(resultB.kept).toBe(true);
    expect(resultB.persist?.durable).toBe(true);
    expect(published).toEqual(["B"]);
    expect(state.blocks.map((block) => block.hash)).toEqual([blockB.hash]);
    expect(state.canonicalBody.omega.tipHash).toBe(blockB.hash);
    expect(state.blocks.some((block) => block.hash === blockA.hash)).toBe(false);
    expect(observe(state).height).toBe(before.height + 1);
    expect(observe(state).miner).toBe(state.canonicalBody.omega.ledger.get(miner)?.balance);
  });

  it("keeps both when the first write commits and the second extends it", async () => {
    const state = genesis();
    const blockA = candidate(state, 6, 1_700_000_000);
    const gate = hold();
    const pendingA = state.commitOperational(blockA, { persist: gate.persist });
    await until(gate.entered);
    const blockB = candidate(state, 7, 1_700_000_012);
    const pendingB = state.commitOperational(blockB, { persist: async () => inserted });
    gate.release(inserted);
    const resultA = await pendingA;
    const resultB = await pendingB;
    expect(resultA.kept).toBe(true);
    expect(resultB.kept).toBe(true);
    expect(state.blocks.map((block) => block.hash)).toEqual([blockA.hash, blockB.hash]);
    expect(state.canonicalBody.omega.tipHash).toBe(blockB.hash);
    expect(state.ledger.balance(miner)).toBe(state.canonicalBody.omega.ledger.get(miner)?.balance);
  });
});

const evidenceMiner = minerKey("mainnet").address;

function evidenceInputs(omega: Omega, nonce: bigint, timestamp: number) {
  return {
    transactions: [],
    timestamp,
    nonce,
    miner: evidenceMiner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
  };
}

describe("a stale evidence successor cannot overwrite the canonical one", () => {
  it("keeps only the successor that installed, when both ran from the same Ω", async () => {
    const body = new CanonicalBody("mainnet");
    const omega = body.omega;
    const pendingA = body.commit(evidenceInputs(omega, 1n, 1_700_000_000));
    const pendingB = body.commit(evidenceInputs(omega, 2n, 1_700_000_012));
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
    const installed = [resultA, resultB].filter((result) => result.ok);
    expect(installed).toHaveLength(1);
    expect(body.blocks).toHaveLength(1);
    expect(body.omega.height).toBe(0);
    expect(body.omega.tipHash).toBe(body.blocks[0]?.hash);
    if (installed[0]?.ok) expect(body.omega.tipHash).toBe(installed[0].hash);
  });

  it("does not let a paused successor overwrite the one that committed while it waited", async () => {
    const state = new ChainState();
    const omega = state.canonicalBody.omega;
    let release: () => void = () => {};
    let paused = false;
    state.canonicalBody.overlapBarrier = () => new Promise<void>((resolve) => {
      paused = true;
      release = resolve;
      state.canonicalBody.overlapBarrier = null;
    });
    const pendingA = state.admitEvidence(evidenceInputs(omega, 1n, 1_700_000_000));
    await until(() => paused);
    const heightWhilePaused = state.canonicalBody.omega.height;
    const pendingB = state.admitEvidence(evidenceInputs(omega, 2n, 1_700_000_012));
    const resultB = await pendingB;
    release();
    const resultA = await pendingA;

    expect(heightWhilePaused).toBe(omega.height);
    expect(resultB.ok).toBe(true);
    expect(resultA.ok).toBe(false);
    if (!resultA.ok) expect(resultA.error).toMatch(/not the successor/);
    expect(state.blocks).toHaveLength(1);
    expect(state.canonicalBody.blocks).toHaveLength(1);
    if (resultB.ok) expect(state.canonicalBody.omega.tipHash).toBe(resultB.hash);
    expect(state.blocks[0]?.hash).toBe(state.canonicalBody.omega.tipHash);
    expect(state.ledger.balance(evidenceMiner)).toBe(state.canonicalBody.omega.ledger.get(evidenceMiner)?.balance);
    expect(state.finalizedHeight).toBe(state.canonicalBody.omega.finalizedHeight);
  });

  it("revalidates a second evidence admission after the first write fails", async () => {
    const state = new ChainState();
    const beforeTip = state.canonicalBody.omega.tipHash;
    const gate = hold();
    const pendingA = state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 3n, 1_700_000_000), {
      persist: gate.persist,
    });
    await until(gate.entered);
    expect(state.blocks).toHaveLength(1);
    const pendingB = state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 4n, 1_700_000_012), {
      persist: async () => inserted,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.blocks).toHaveLength(1);

    gate.release(failed);
    const resultA = await pendingA;
    const resultB = await pendingB;
    expect(resultA.kept).toBe(false);
    expect(resultB.kept).toBe(true);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]?.hash).toBe(resultB.hash);
    expect(state.canonicalBody.omega.tipHash).not.toBe(beforeTip);
    expect(state.canonicalBody.omega.tipHash).toBe(resultB.hash);
    expect(state.ledger.balance(evidenceMiner)).toBe(state.canonicalBody.omega.ledger.get(evidenceMiner)?.balance);
  });
});

function stored(hash: string, minerAddress = "ab".repeat(20)): BlockRecord {
  return {
    hash,
    height: 1,
    prevHash: "0".repeat(64),
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: 6,
    difficulty: 1,
    residual: 0,
    residualFp: 0,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner: minerAddress,
    txCount: 0,
    transactions: [],
    finalized: false,
    stateRoot: "cd".repeat(32),
    committedPressure: 0,
  };
}

describe("persistBlock names the database outcome", () => {
  it("does not call a missing database a durable write", async () => {
    const result = await persistBlockUsing(null, stored("11".repeat(32)));
    expect(result).toEqual({ durable: false, outcome: "absent" });
  });

  it("does not call a failed transaction a durable write", async () => {
    const db = {
      transaction: async () => {
        throw new Error("disk full");
      },
    };
    const result = await persistBlockUsing(db, stored("22".repeat(32)));
    expect(result).toEqual({ durable: false, outcome: "failed" });
  });

  it("distinguishes an insert, the same row, and a conflicting row", async () => {
    const client = new PGlite();
    await client.exec(`
      CREATE TABLE blocks (
        hash text PRIMARY KEY,
        height integer NOT NULL,
        prev_hash text NOT NULL,
        merkle_root text NOT NULL,
        timestamp bigint NOT NULL,
        nonce numeric(20,0) NOT NULL,
        difficulty real NOT NULL,
        residual real NOT NULL,
        residual_fp bigint,
        miner text NOT NULL,
        tx_count integer NOT NULL DEFAULT 0,
        coinbase_reward bigint NOT NULL DEFAULT 0,
        finalized boolean NOT NULL DEFAULT false,
        zk_proof jsonb,
        state_root text,
        committed_pressure double precision,
        chain_id integer,
        evidence_root text,
        omega_root text,
        evidence jsonb
      );
      CREATE TABLE transactions (
        hash text PRIMARY KEY,
        block_hash text,
        block_height integer,
        from_address text NOT NULL,
        to_address text NOT NULL,
        amount bigint NOT NULL,
        fee bigint NOT NULL DEFAULT 0,
        nonce bigint NOT NULL,
        signature text NOT NULL,
        public_key text,
        tx_index integer,
        status text NOT NULL DEFAULT 'pending',
        timestamp bigint NOT NULL
      );
    `);
    const db = drizzle(client, { schema: { blocksTable } });
    const block = stored("33".repeat(32));
    const first = await persistBlockUsing(db, block);
    expect(first).toEqual({ durable: true, outcome: "inserted" });
    const again = await persistBlockUsing(db, block);
    expect(again).toEqual({ durable: true, outcome: "identical" });

    const conflict = await persistBlockUsing(db, { ...block, miner: "ef".repeat(20), stateRoot: "ab".repeat(32) });
    expect(conflict).toEqual({ durable: false, outcome: "conflict" });
    const [row] = await db.select().from(blocksTable).where(eq(blocksTable.hash, block.hash));
    expect(row?.miner).toBe(block.miner);
    expect(row?.stateRoot).toBe(block.stateRoot);
    await client.close();
  });

  it("a same-hash rewrite of difficulty, zkProof, or evidence is a conflict", async () => {
    const client = new PGlite();
    await client.exec(`
      CREATE TABLE blocks (
        hash text PRIMARY KEY,
        height integer NOT NULL,
        prev_hash text NOT NULL,
        merkle_root text NOT NULL,
        timestamp bigint NOT NULL,
        nonce numeric(20,0) NOT NULL,
        difficulty real NOT NULL,
        residual real NOT NULL,
        residual_fp bigint,
        miner text NOT NULL,
        tx_count integer NOT NULL DEFAULT 0,
        coinbase_reward bigint NOT NULL DEFAULT 0,
        finalized boolean NOT NULL DEFAULT false,
        zk_proof jsonb,
        state_root text,
        committed_pressure double precision,
        chain_id integer,
        evidence_root text,
        omega_root text,
        evidence jsonb
      );
      CREATE TABLE transactions (
        hash text PRIMARY KEY,
        block_hash text,
        block_height integer,
        from_address text NOT NULL,
        to_address text NOT NULL,
        amount bigint NOT NULL,
        fee bigint NOT NULL DEFAULT 0,
        nonce bigint NOT NULL,
        signature text NOT NULL,
        public_key text,
        tx_index integer,
        status text NOT NULL DEFAULT 'pending',
        timestamp bigint NOT NULL
      );
    `);
    const db = drizzle(client, { schema: { blocksTable, transactionsTable } });
    const block = stored("55".repeat(32));
    expect(await persistBlockUsing(db, block)).toEqual({ durable: true, outcome: "inserted" });

    const difficulty = await persistBlockUsing(db, { ...block, difficulty: block.difficulty + 1 });
    expect(difficulty).toEqual({ durable: false, outcome: "conflict" });
    const [afterDifficulty] = await db.select().from(blocksTable).where(eq(blocksTable.hash, block.hash));
    expect(afterDifficulty?.difficulty).toBe(block.difficulty);

    const zkProof: BlockRecord["zkProof"] = {
      proof: {
        pi_a: { x: "1", y: "2" },
        pi_b: { x: ["3", "4"], y: ["5", "6"] },
        pi_c: { x: "7", y: "8" },
      },
      publicInputs: { residual: "0", threshold: "1", blockHashLow: "ab", blockHashHigh: "cd" },
      vkHash: "ef".repeat(32),
      valid: false,
      provedAt: 1,
      circuitId: "stationarity",
    };
    expect(await persistBlockUsing(db, { ...block, zkProof })).toEqual({ durable: false, outcome: "conflict" });
    const [afterProof] = await db.select().from(blocksTable).where(eq(blocksTable.hash, block.hash));
    expect(afterProof?.zkProof).toBeNull();

    const evidence: NonNullable<BlockRecord["evidence"]> = {
      v: 1,
      chainId: 1,
      wasmCode: "",
      btc: [],
      eth: [],
      wasm: [],
      stake: [],
    };
    expect(await persistBlockUsing(db, { ...block, evidence })).toEqual({ durable: false, outcome: "conflict" });
    const [afterEvidence] = await db.select().from(blocksTable).where(eq(blocksTable.hash, block.hash));
    expect(afterEvidence?.evidence).toBeNull();
    expect(await persistBlockUsing(db, block)).toEqual({ durable: true, outcome: "identical" });
    await client.close();
  });

  it("deletes the transaction rows of the blocks it prunes", async () => {
    const client = new PGlite();
    await client.exec(`
      CREATE TABLE blocks (
        hash text PRIMARY KEY,
        height integer NOT NULL,
        prev_hash text NOT NULL,
        merkle_root text NOT NULL,
        timestamp bigint NOT NULL,
        nonce numeric(20,0) NOT NULL,
        difficulty real NOT NULL,
        residual real NOT NULL,
        residual_fp bigint,
        miner text NOT NULL,
        tx_count integer NOT NULL DEFAULT 0,
        coinbase_reward bigint NOT NULL DEFAULT 0,
        finalized boolean NOT NULL DEFAULT false,
        zk_proof jsonb,
        state_root text,
        committed_pressure double precision,
        chain_id integer,
        evidence_root text,
        omega_root text,
        evidence jsonb
      );
      CREATE TABLE transactions (
        hash text PRIMARY KEY,
        block_hash text,
        block_height integer,
        from_address text NOT NULL,
        to_address text NOT NULL,
        amount bigint NOT NULL,
        fee bigint NOT NULL DEFAULT 0,
        nonce bigint NOT NULL,
        signature text NOT NULL,
        public_key text,
        tx_index integer,
        status text NOT NULL DEFAULT 'pending',
        timestamp bigint NOT NULL
      );
    `);
    const db = drizzle(client, { schema: { blocksTable, transactionsTable } });
    const keep = stored("66".repeat(32));
    keep.height = 0;
    const gone = stored("77".repeat(32));
    gone.height = 2;
    expect(await persistBlockUsing(db, keep)).toEqual({ durable: true, outcome: "inserted" });
    expect(await persistBlockUsing(db, gone)).toEqual({ durable: true, outcome: "inserted" });
    await db.insert(transactionsTable).values({
      hash: "88".repeat(32),
      blockHash: gone.hash,
      blockHeight: gone.height,
      from: "aa".repeat(20),
      to: "bb".repeat(20),
      amount: 1,
      fee: 0,
      nonce: 0,
      signature: "ab".repeat(64),
      status: "confirmed",
      timestamp: 1,
    });
    expect(await deletePrunedBlockRows(db, 3)).toBe(1);
    const blocks = await db.select().from(blocksTable);
    expect(blocks.map((row) => row.hash)).toEqual([keep.hash]);
    const txs = await db.select().from(transactionsTable);
    expect(txs).toEqual([]);
    await client.close();
  });

  it("deletes an abandoned sibling and the transaction that names it, and leaves the other child", async () => {
    const client = new PGlite();
    await client.exec(`
      CREATE TABLE blocks (
        hash text PRIMARY KEY,
        height integer NOT NULL,
        prev_hash text NOT NULL,
        merkle_root text NOT NULL,
        timestamp bigint NOT NULL,
        nonce numeric(20,0) NOT NULL,
        difficulty real NOT NULL,
        residual real NOT NULL,
        residual_fp bigint,
        miner text NOT NULL,
        tx_count integer NOT NULL DEFAULT 0,
        coinbase_reward bigint NOT NULL DEFAULT 0,
        finalized boolean NOT NULL DEFAULT false,
        zk_proof jsonb,
        state_root text,
        committed_pressure double precision,
        chain_id integer,
        evidence_root text,
        omega_root text,
        evidence jsonb
      );
      CREATE TABLE transactions (
        hash text PRIMARY KEY,
        block_hash text,
        block_height integer,
        from_address text NOT NULL,
        to_address text NOT NULL,
        amount bigint NOT NULL,
        fee bigint NOT NULL DEFAULT 0,
        nonce bigint NOT NULL,
        signature text NOT NULL,
        public_key text,
        tx_index integer,
        status text NOT NULL DEFAULT 'pending',
        timestamp bigint NOT NULL
      );
    `);
    const db = drizzle(client, { schema: { blocksTable, transactionsTable } });
    const genesisRow = stored("11".repeat(32));
    genesisRow.height = 0;
    genesisRow.prevHash = "00".repeat(32);
    const kept = stored("22".repeat(32));
    kept.height = 1;
    kept.prevHash = genesisRow.hash;
    const abandoned = stored("33".repeat(32));
    abandoned.height = 1;
    abandoned.prevHash = genesisRow.hash;
    expect(await persistBlockUsing(db, genesisRow)).toEqual({ durable: true, outcome: "inserted" });
    expect(await persistBlockUsing(db, kept)).toEqual({ durable: true, outcome: "inserted" });
    expect(await persistBlockUsing(db, abandoned)).toEqual({ durable: true, outcome: "inserted" });
    await db.insert(transactionsTable).values({
      hash: "44".repeat(32),
      blockHash: abandoned.hash,
      blockHeight: 1,
      from: "aa".repeat(20),
      to: "bb".repeat(20),
      amount: 1,
      fee: 0,
      nonce: 0,
      signature: "ab".repeat(64),
      status: "confirmed",
      timestamp: 1,
    });
    const before = await db.select().from(blocksTable);
    const forked = operationalReplaySet(before.map((row) => ({
      hash: row.hash,
      height: row.height,
      prevHash: row.prevHash,
      evidence: null,
    })));
    expect(forked.retained.map((row) => row.hash).sort()).toEqual([kept.hash, abandoned.hash].sort());
    expect(await deleteAbandonedBlockRows(db, [abandoned.hash])).toBe(1);
    const after = await db.select().from(blocksTable);
    const replay = operationalReplaySet(after.map((row) => ({
      hash: row.hash,
      height: row.height,
      prevHash: row.prevHash,
      evidence: null,
    })));
    expect(replay.retained).toEqual([]);
    expect(replay.replay.map((row) => row.hash).sort()).toEqual([genesisRow.hash, kept.hash].sort());
    const txs = await db.select().from(transactionsTable);
    expect(txs).toEqual([]);
    await client.close();
  });

  it("a database that inserts the row is not a failed write", async () => {
    const result = await persistBlock(stored("44".repeat(32)));
    expect(result.outcome === "absent" || result.outcome === "inserted" || result.outcome === "identical").toBe(true);
    expect(result.durable).toBe(result.outcome !== "absent");
  });
});
