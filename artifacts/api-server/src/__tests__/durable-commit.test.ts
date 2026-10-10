/**
 * Durable admission. These run against the process, not a source trace.
 * A failed write must not delete a later block. A stale evidence successor
 * must not overwrite a newer one. persistBlock must name what the database did.
 */
import { describe, it, expect } from "vitest";
import { PGlite } from "../../../../site/node_modules/@electric-sql/pglite";
import { drizzle } from "../../../../site/node_modules/drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { ChainState, buildGenesisChainFromDoc } from "../chain/state.js";
import { CanonicalBody } from "../chain/canonical-body.js";
import { kernelParty, KERNEL_ALLOCATIONS } from "../chain/kernel-genesis.js";
import { persistBlock, persistBlockUsing, type PersistBlockResult } from "../chain/persistence.js";
import { blocksTable } from "../../../../lib/db/src/schema/blocks.ts";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { minerKey } from "../../../../site/src/protocol/genesis.js";
import type { BlockRecord } from "../chain/types.js";
import type { Omega } from "../../../../site/src/protocol/types.js";

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

  it("reports a configured database that does not commit as failed, not absent", async () => {
    const result = await persistBlock(stored("44".repeat(32)));
    expect(result.durable).toBe(false);
    expect(result.outcome).toBe("failed");
  });
});
