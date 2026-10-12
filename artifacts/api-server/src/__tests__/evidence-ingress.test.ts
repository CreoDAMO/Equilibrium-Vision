/**
 * Evidence ingress installs and persists one record.
 * A remote transaction list that the hash was not sealed for is not written.
 * This does not cover snapshot restore, the operational loader, or a live socket.
 */
import { describe, expect, it } from "vitest";
import { ChainState } from "../chain/state.js";
import { admitRemoteEvidence } from "../chain/evidence-ingress.js";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { minerKey } from "../../../../site/src/protocol/genesis.js";
import { keypairFromSeed, signTx } from "../../../../site/src/protocol/wallet.js";
import type { BlockRecord } from "../chain/types.js";
import type { TxRecord as ProtocolTx } from "../../../../site/src/protocol/types.js";
import type { PersistBlockResult } from "../chain/persistence.js";

const miner = minerKey("mainnet").address;
const inserted: PersistBlockResult = { durable: true, outcome: "inserted" };
const failed: PersistBlockResult = { durable: false, outcome: "failed" };

function fresh(): ChainState {
  return new ChainState();
}

function fund(state: ChainState, address: string, amount: number): void {
  state.canonicalBody.omega.ledger.set(address, { balance: amount, nonce: 0 });
}

async function seal(state: ChainState, txs: ProtocolTx[] = []): Promise<BlockRecord> {
  const omega = state.canonicalBody.omega;
  const outcome = await state.commitEvidence({
    transactions: txs,
    timestamp: 1_700_000_000,
    nonce: 6n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
  }, { persist: async () => inserted });
  if (!outcome.kept) throw new Error(outcome.error ?? "seal failed");
  const block = state.blocks[state.blocks.length - 1];
  if (!block) throw new Error("seal did not install a block");
  return block;
}

function payerTx(state: ChainState): ProtocolTx {
  const payer = keypairFromSeed("equilibrium-evidence-payer");
  fund(state, payer.address, 50_000);
  return signTx(payer, {
    to: "cd".repeat(20),
    amount: 1_000,
    fee: 1,
    nonce: 0,
    chainId: state.canonicalBody.omega.chainId,
    timestamp: 1_700_000_000,
  });
}

describe("a remote evidence body is one transaction set", () => {
  it("installs the replayed list and persists that same block", async () => {
    const origin = fresh();
    const tx = payerTx(origin);
    const sealed = await seal(origin, [tx]);
    expect(sealed.transactions).toHaveLength(1);
    expect(sealed.txCount).toBe(1);

    const copy = fresh();
    fund(copy, tx.from, 50_000);
    const kept: { block: BlockRecord | null } = { block: null };
    const outcome = await admitRemoteEvidence(copy, { ...sealed }, sealed.hash, async (block) => {
      kept.block = block;
      return inserted;
    });

    expect(outcome.kept).toBe(true);
    expect(kept.block).toBe(copy.getBlockByHash(sealed.hash));
    expect(kept.block?.transactions.map((row) => row.hash)).toEqual([tx.hash]);
    expect(kept.block?.txCount).toBe(kept.block?.transactions.length);
    expect(kept.block?.merkleRoot).toBe(sealed.merkleRoot);
    expect(copy.canonicalBody.omega.tipHash).toBe(sealed.hash);
    expect(copy.ledger.balance("cd".repeat(20))).toBe(1_000);
  });

  it("admits an empty evidence block without inventing a second record", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const kept: { block: BlockRecord | null } = { block: null };
    const outcome = await admitRemoteEvidence(copy, { ...sealed }, sealed.hash, async (block) => {
      kept.block = block;
      return inserted;
    });
    expect(outcome.kept).toBe(true);
    expect(kept.block?.transactions).toEqual([]);
    expect(kept.block?.txCount).toBe(0);
    expect(copy.blocks).toHaveLength(1);
    expect(copy.blocks[0]?.hash).toBe(sealed.hash);
  });

  it("does not persist a transaction list the hash was not sealed for", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const beforeTip = copy.canonicalBody.omega.tipHash;
    let writes = 0;
    const stuffed = {
      ...sealed,
      txCount: 1,
      transactions: [{
        hash: "ab".repeat(32),
        from: "aa".repeat(20),
        to: "bb".repeat(20),
        amount: 1,
        fee: 0,
        nonce: 0,
        timestamp: 1,
        status: "confirmed" as const,
        blockHash: null,
        blockHeight: null,
      }],
    };
    const outcome = await admitRemoteEvidence(copy, stuffed, sealed.hash, async () => {
      writes += 1;
      return inserted;
    });
    expect(outcome.kept).toBe(false);
    expect(outcome.admitted).toBe(false);
    expect(writes).toBe(0);
    expect(copy.blocks).toHaveLength(0);
    expect(copy.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(copy.canonicalBody.omega.height).toBe(-1);
    expect(copy.getBlockByHash(sealed.hash)).toBeUndefined();
  });

  it("refuses a count that is not the list length", async () => {
    const origin = fresh();
    const tx = payerTx(origin);
    const sealed = await seal(origin, [tx]);
    const copy = fresh();
    fund(copy, tx.from, 50_000);
    let writes = 0;
    const outcome = await admitRemoteEvidence(copy, { ...sealed, txCount: 0 }, sealed.hash, async () => {
      writes += 1;
      return inserted;
    });
    expect(outcome).toMatchObject({ admitted: false, kept: false, error: "txCount is not the transaction set" });
    expect(writes).toBe(0);
    expect(copy.canonicalBody.omega.height).toBe(-1);
  });

  it("refuses a merkle root that is not the replayed set", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    let writes = 0;
    const outcome = await admitRemoteEvidence(
      copy,
      { ...sealed, merkleRoot: "ab".repeat(32) },
      sealed.hash,
      async () => {
        writes += 1;
        return inserted;
      },
    );
    expect(outcome).toMatchObject({ admitted: false, kept: false, error: "merkle root is not the transaction set" });
    expect(writes).toBe(0);
    expect(copy.blocks).toHaveLength(0);
    expect(copy.canonicalBody.omega.height).toBe(-1);
  });

  it("refuses a parent or height that is not the successor", async () => {
    const sealed = await seal(fresh());
    const parent = fresh();
    const height = fresh();
    expect((await admitRemoteEvidence(parent, { ...sealed, prevHash: "1".repeat(64) }, sealed.hash, async () => inserted)).error)
      .toBe("prevHash is not the predecessor");
    expect((await admitRemoteEvidence(height, { ...sealed, height: 4 }, sealed.hash, async () => inserted)).error)
      .toBe("height is not the successor height");
    expect(parent.canonicalBody.omega.height).toBe(-1);
    expect(height.blocks).toHaveLength(0);
  });

  it("refuses a body whose hash is not the announcement", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const outcome = await admitRemoteEvidence(copy, { ...sealed }, "ff".repeat(32), async () => inserted);
    expect(outcome).toMatchObject({ admitted: false, kept: false, error: "hash is not the announced block" });
    expect(copy.blocks).toHaveLength(0);
  });

  it("rolls the canonical tip back when the write does not keep the block", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const beforeTip = copy.canonicalBody.omega.tipHash;
    const outcome = await admitRemoteEvidence(copy, { ...sealed }, sealed.hash, async () => failed);
    expect(outcome.admitted).toBe(true);
    expect(outcome.kept).toBe(false);
    expect(outcome.persist).toEqual(failed);
    expect(copy.blocks).toHaveLength(0);
    expect(copy.canonicalBody.omega.height).toBe(-1);
    expect(copy.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(copy.getBlockByHash(sealed.hash)).toBeUndefined();
  });
});
