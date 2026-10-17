/**
 * A reorganization is the branch a restart can load.
 * The replacement rows and the abandoned rows commit together, or neither does.
 * The tip is published only after that commit.
 */
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ChainState } from "../chain/state.js";
import { commitBranchSwitch, persistBlockUsing } from "../chain/persistence.js";
import { operationalReplaySet, recoveryVerdict } from "../chain/restart-boundary.js";
import { blocksTable } from "../../../../lib/db/src/schema/blocks.ts";
import { transactionsTable } from "../../../../lib/db/src/schema/transactions.ts";
import { stateSnapshotsTable } from "../../../../lib/db/src/schema/state-snapshots.ts";
import { kernelParty } from "../chain/kernel-genesis.js";
import { applySuccessor, openedCouplings } from "../../../../site/src/protocol/constitution.js";
import type { BlockRecord } from "../chain/types.js";

const miner = kernelParty("mainnet").miner;

function block(partial: Partial<BlockRecord> & Pick<BlockRecord, "hash" | "height" | "prevHash">): BlockRecord {
  return {
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: 6,
    difficulty: 1_000_000,
    residual: 1e-6,
    residualFp: 1,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    txCount: 0,
    transactions: [],
    committedPressure: 0,
    ...partial,
  };
}

async function database() {
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
    CREATE TABLE state_snapshots (
      height integer PRIMARY KEY,
      block_hash text NOT NULL,
      state_root text NOT NULL,
      ledger jsonb NOT NULL,
      utxos jsonb NOT NULL,
      created_at bigint NOT NULL
    );
  `);
  const db = drizzle(client, { schema: { blocksTable, transactionsTable, stateSnapshotsTable } });
  return { client, db };
}

describe("an equal residual uses the same tie as the site", () => {
  it("refuses the larger tip hash and does not refuse the smaller one for weight", async () => {
    const state = new ChainState();
    const fork = block({ hash: "aa".repeat(32), height: 0, prevHash: "00".repeat(32), residualFp: 5 });
    const incumbent = block({ hash: "cc".repeat(32), height: 1, prevHash: fork.hash, residualFp: 10 });
    state.blocks.push(fork, incumbent);
    const heavier = block({ hash: "ee".repeat(32), height: 1, prevHash: fork.hash, residualFp: 10 });
    const lighter = block({ hash: "11".repeat(32), height: 1, prevHash: fork.hash, residualFp: 10 });

    const lost = await state.reorganize([heavier], null);
    expect(lost.switched).toBe(false);
    expect(lost.reason).toBe("candidate chain does not have lower cumulative residual");

    const won = await state.reorganize([lighter], null);
    expect(won.reason).not.toBe("candidate chain does not have lower cumulative residual");
  });
});

describe("a branch switch commits the winner and drops the loser together", () => {
  it("does not ask the database when the fork is not on the chain", async () => {
    const state = new ChainState();
    const tip = state.canonicalBody.omega.tipHash;
    let called = false;
    const result = await state.reorganize([
      block({ hash: "ab".repeat(32), height: 0, prevHash: "12".repeat(32) }),
    ], {
      transaction: async () => {
        called = true;
        throw new Error("should not be asked");
      },
    });
    expect(result).toEqual({ switched: false, fenced: false, reason: "fork point not found on current chain" });
    expect(called).toBe(false);
    expect(state.canonicalBody.omega.tipHash).toBe(tip);
  });

  it("leaves the incumbent rows when the transaction fails", async () => {
    const { client, db } = await database();
    const kept = block({ hash: "11".repeat(32), height: 0, prevHash: "00".repeat(32), stateRoot: "aa".repeat(32) });
    const loser = block({ hash: "22".repeat(32), height: 1, prevHash: kept.hash, stateRoot: "bb".repeat(32) });
    expect(await persistBlockUsing(db, kept)).toMatchObject({ outcome: "inserted" });
    expect(await persistBlockUsing(db, loser)).toMatchObject({ outcome: "inserted" });
    const winner = block({
      hash: "22".repeat(32),
      height: 1,
      prevHash: kept.hash,
      miner: "cd".repeat(20),
      stateRoot: "cc".repeat(32),
    });
    const result = await commitBranchSwitch(db, {
      replacement: [winner],
      abandoned: [loser.hash],
      preserve: [kept.hash],
    });
    expect(result.committed).toBe(false);
    const rows = await db.select().from(blocksTable);
    expect(rows.map((row) => row.hash).sort()).toEqual([kept.hash, loser.hash].sort());
    expect(rows.find((row) => row.hash === loser.hash)?.miner).toBe(miner);
    await client.close();
  });

  it("refuses to delete the ancestor and does not insert the replacement", async () => {
    const { client, db } = await database();
    const kept = block({ hash: "11".repeat(32), height: 0, prevHash: "00".repeat(32), stateRoot: "aa".repeat(32) });
    expect(await persistBlockUsing(db, kept)).toMatchObject({ outcome: "inserted" });
    const result = await commitBranchSwitch(db, {
      replacement: [block({ hash: "33".repeat(32), height: 1, prevHash: kept.hash, stateRoot: "bb".repeat(32) })],
      abandoned: [kept.hash],
      preserve: [kept.hash],
    });
    expect(result).toEqual({ committed: false, reason: "branch switch would delete a preserved block" });
    const rows = await db.select().from(blocksTable);
    expect(rows.map((row) => row.hash)).toEqual([kept.hash]);
    await client.close();
  });

  it("publishes the tip only after the winning rows are the ones a restart loads", async () => {
    const { client, db } = await database();
    const state = new ChainState();
    const ancestorBlock = block({
      hash: "a1".repeat(32),
      height: 0,
      prevHash: state.canonicalBody.omega.tipHash,
      difficulty: state.canonicalBody.omega.difficulty,
    });
    state.addBlock(ancestorBlock);
    const ancestor = state.blocks[0]!.hash;
    const forkDiff = state.canonicalBody.omega.difficulty;
    const forkTs = 1_700_000_020;
    const ranked: Array<{ nonce: number; fp: number }> = [];
    for (let nonce = 0; ranked.length < 2 && nonce < 50_000; nonce++) {
      const stepped = applySuccessor(state.canonicalBody.omega, {
        transactions: [],
        evidence: undefined,
        timestamp: forkTs,
        nonce: BigInt(nonce),
        miner,
        committedPressure: 0,
        couplings: openedCouplings(state.canonicalBody.omega),
        difficulty: forkDiff,
        wasmAfter: null,
      });
      if (stepped.ok && stepped.residual < state.admissionTarget && !ranked.some((row) => row.fp === stepped.residualFp)) {
        ranked.push({ nonce, fp: stepped.residualFp });
      }
    }
    ranked.sort((a, b) => (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));
    const low = ranked[0];
    const high = ranked[ranked.length - 1];
    expect(low && high && low.fp < high.fp).toBe(true);
    const incumbent = block({
      hash: "b2".repeat(32),
      height: 1,
      prevHash: ancestor,
      difficulty: forkDiff,
      timestamp: forkTs,
      nonce: high!.nonce,
      residualFp: high!.fp,
    });
    state.addBlock(incumbent);
    const incumbentHash = state.blocks[1]!.hash;
    const before = state.canonicalBody.omega.tipHash;
    expect(await persistBlockUsing(db, state.blocks[0]!)).toMatchObject({ durable: true });
    expect(await persistBlockUsing(db, state.blocks[1]!)).toMatchObject({ durable: true });
    await db.insert(transactionsTable).values({
      hash: "44".repeat(32),
      blockHash: incumbentHash,
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
    await db.insert(stateSnapshotsTable).values([
      { height: 0, blockHash: ancestor, stateRoot: "11".repeat(32), ledger: {}, utxos: [], createdAt: 1 },
      { height: 1, blockHash: incumbentHash, stateRoot: "22".repeat(32), ledger: {}, utxos: [], createdAt: 2 },
    ]);

    const failing = {
      transaction: async () => {
        throw new Error("disk full");
      },
    };
    const refused = await state.reorganize([
      block({
        hash: "c3".repeat(32),
        height: 1,
        prevHash: ancestor,
        difficulty: forkDiff,
        timestamp: forkTs,
        nonce: low!.nonce,
        residualFp: low!.fp,
      }),
    ], failing);
    expect(refused.switched).toBe(false);
    expect(refused.fenced).toBe(false);
    expect(refused.reason).toBe("disk full");
    expect(state.canonicalBody.omega.tipHash).toBe(before);
    expect(state.serviceFenced).toBe(false);

    const switched = await state.reorganize([
      block({
        hash: "c3".repeat(32),
        height: 1,
        prevHash: ancestor,
        difficulty: forkDiff,
        timestamp: forkTs,
        nonce: low!.nonce,
        residualFp: low!.fp,
      }),
    ], db);
    expect(switched.switched).toBe(true);
    expect(switched.fenced).toBe(false);
    expect(state.blocks[1]?.hash).toBe(state.canonicalBody.omega.tipHash);
    expect(state.blocks[1]?.hash).not.toBe(incumbentHash);

    const rows = await db.select().from(blocksTable);
    const replay = operationalReplaySet(rows.map((row) => ({
      hash: row.hash,
      height: row.height,
      prevHash: row.prevHash,
      evidence: null,
    })));
    expect(replay.retained).toEqual([]);
    expect(replay.replay.map((row) => row.hash).sort()).toEqual([ancestor, state.blocks[1]!.hash].sort());
    expect(recoveryVerdict({
      configured: true,
      queryFailed: false,
      operationalRows: rows.length,
      evidenceRows: 0,
      replay: replay.replay.length,
      retained: replay.retained.length,
    }).verdict).toBe("restored");
    const txs = await db.select().from(transactionsTable);
    expect(txs).toEqual([]);
    const snaps = await db.select().from(stateSnapshotsTable);
    expect(snaps.map((row) => row.blockHash)).toEqual([ancestor]);
    await client.close();
  });
});
