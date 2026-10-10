/**
 * A canonical signature has to survive the write, and the miner has to check that same message.
 * A blank stored signature is not a replay. A text-field signature is not the canonical one.
 */
import { describe, it, expect } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { PGlite } from "../../../../site/node_modules/@electric-sql/pglite";
import { drizzle } from "../../../../site/node_modules/drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { ChainState, buildGenesisChainFromDoc, retainCanonicalTransactions } from "../chain/state.js";
import { kernelParty, KERNEL_ALLOCATIONS } from "../chain/kernel-genesis.js";
import { persistBlockUsing } from "../chain/persistence.js";
import { blocksTable } from "../../../../lib/db/src/schema/blocks.ts";
import { transactionsTable } from "../../../../lib/db/src/schema/transactions.ts";
import { StratumServer, stratumNonce } from "../lib/stratum-server.js";
import { bytesToHex } from "../../../../site/src/protocol/bytes.js";
import { keypairFromSeed, signTx } from "../../../../site/src/protocol/wallet.js";
import type { BlockRecord, TxRecord } from "../chain/types.js";

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

function fund(state: ChainState, address: string, amount: number): void {
  state.canonicalBody.omega.ledger.set(address, { balance: amount, nonce: 0 });
}

function blockWith(state: ChainState, txs: TxRecord[]): BlockRecord {
  const omega = state.canonicalBody.omega;
  return {
    hash: "11".repeat(32),
    height: omega.height + 1,
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: 6,
    difficulty: omega.difficulty,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    txCount: txs.length,
    transactions: txs,
    committedPressure: 0,
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
  `);
  const db = drizzle(client, { schema: { blocksTable, transactionsTable } });
  return { client, db };
}

describe("the signature that admitted the transaction is the one that is stored", () => {
  it("replays a restored transaction and refuses a blank signature", async () => {
    const state = genesis();
    const payer = keypairFromSeed("equilibrium-canonical-payer");
    fund(state, payer.address, 50_000);
    const tx = signTx(payer, {
      to: "cd".repeat(20),
      amount: 1_000,
      fee: 1_000,
      nonce: 0,
      chainId: state.canonicalBody.omega.chainId,
      timestamp: 1_700_000_000,
    });
    state.addBlock(blockWith(state, [tx]));
    const sealed = state.blocks[0]!;
    expect(sealed.transactions[0]?.signature).toBe(tx.signature);
    expect(sealed.transactions[0]?.publicKey).toBe(tx.publicKey);

    const { client, db } = await database();
    const written = await persistBlockUsing(db, sealed);
    expect(written).toEqual({ durable: true, outcome: "inserted" });
    const again = await persistBlockUsing(db, sealed);
    expect(again).toEqual({ durable: true, outcome: "identical" });
    const [row] = await db.select().from(transactionsTable).where(eq(transactionsTable.blockHash, sealed.hash));
    expect(row?.signature).toBe(tx.signature);
    expect(row?.publicKey).toBe(tx.publicKey);
    expect(row?.txIndex).toBe(0);

    const changed = {
      ...sealed,
      transactions: [{ ...sealed.transactions[0]!, signature: "ab".repeat(64) }],
    };
    const conflict = await persistBlockUsing(db, changed);
    expect(conflict).toEqual({ durable: false, outcome: "conflict" });
    const [kept] = await db.select().from(transactionsTable).where(eq(transactionsTable.hash, tx.hash));
    expect(kept?.signature).toBe(tx.signature);

    const fresh = genesis();
    fund(fresh, row!.from, 50_000);
    fresh.addBlock({
      ...sealed,
      transactions: [{
        hash: row!.hash,
        from: row!.from,
        to: row!.to,
        amount: Number(row!.amount),
        fee: Number(row!.fee),
        nonce: Number(row!.nonce),
        timestamp: Number(row!.timestamp),
        status: "confirmed",
        blockHash: row!.blockHash,
        blockHeight: row!.blockHeight,
        signature: row!.signature,
        publicKey: row!.publicKey ?? undefined,
      }],
    });
    expect(fresh.canonicalBody.omega.height).toBe(0);
    expect(fresh.canonicalBody.omega.tipHash).toBe(sealed.hash);
    expect(fresh.ledger.balance("cd".repeat(20))).toBe(1_000);

    const blank = genesis();
    expect(() => blank.addBlock({
      ...sealed,
      transactions: [{ ...tx, signature: "" }],
    })).toThrow(/signature refused/);
    expect(blank.canonicalBody.omega.height).toBe(-1);
    await client.close();
  });

  it("drops a text-field signature and keeps the canonical one", () => {
    const state = genesis();
    const payer = keypairFromSeed("equilibrium-canonical-payer");
    fund(state, payer.address, 50_000);
    const to = "cd".repeat(20);
    const canonical = signTx(payer, {
      to,
      amount: 1_000,
      fee: 1_000,
      nonce: 0,
      chainId: state.canonicalBody.omega.chainId,
      timestamp: 1_700_000_000,
    });
    const sk = ed25519.utils.randomSecretKey();
    const pk = ed25519.getPublicKey(sk);
    const textFrom = bytesToHex(sha256(pk)).slice(0, 40);
    fund(state, textFrom, 50_000);
    const message = new TextEncoder().encode(`${textFrom}${to}${1_000}${1_000}${0}`);
    const textTx: TxRecord = {
      hash: "ab".repeat(32),
      from: textFrom,
      to,
      amount: 1_000,
      fee: 1_000,
      nonce: 0,
      timestamp: 1_700_000_000,
      status: "pending",
      signature: bytesToHex(ed25519.sign(message, sk)),
      publicKey: bytesToHex(pk),
      blockHash: null,
      blockHeight: null,
    };
    state.mempool.add(canonical);
    state.mempool.add(textTx);
    const kept = retainCanonicalTransactions(state, state.selectCanonical(state.mempool.all()));
    expect(kept.map((tx) => tx.hash)).toEqual([canonical.hash]);
    expect(state.mempool.all().some((tx) => tx.hash === textTx.hash)).toBe(false);
    expect(state.mempool.all().some((tx) => tx.hash === canonical.hash)).toBe(true);
  });
});

describe("stratum nonce and producer", () => {
  it("does not round a nonce above 2^53", () => {
    const above = (1n << 53n) + 1n;
    expect(stratumNonce(above.toString(16))).toBe(above);
    expect(BigInt(parseInt(above.toString(16), 16))).not.toBe(above);
  });

  it("refuses a miner the successor would refuse, before the block is admitted", async () => {
    const server = new StratumServer(0);
    const state = genesis();
    server.attachChain(state);
    const hidden = server as unknown as {
      activeJobs: Map<string, { tipHash: string; pressure: number }>;
      onSubmit: (
        session: {
          socket: { writable: boolean; write: (data: string) => void };
          sessionId: string;
          worker: string | null;
          authorized: boolean;
          extraNonce: string;
          remoteIp: string;
        },
        req: { id: number; method: string; params: string[] },
      ) => Promise<void>;
    };
    hidden.activeJobs.set("00000001", { tipHash: state.canonicalWork().prevHash, pressure: 0 });
    const lines: string[] = [];
    await hidden.onSubmit(
      {
        socket: { writable: true, write: (data: string) => { lines.push(data); } },
        sessionId: "s",
        worker: "ab".repeat(20),
        authorized: true,
        extraNonce: "00",
        remoteIp: "127.0.0.1",
      },
      { id: 7, method: "mining.submit", params: ["ab".repeat(20), "00000001", "00", "", "01", "0"] },
    );
    expect(JSON.parse(lines[0]!).error[1]).toBe("miner is not a live validator");
    expect(state.canonicalBody.omega.height).toBe(-1);
    expect(state.blocks).toHaveLength(0);
  });
});
