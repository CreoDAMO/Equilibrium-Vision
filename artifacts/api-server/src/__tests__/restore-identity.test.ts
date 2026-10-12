/**
 * A restored block keeps the transaction list it committed and the identity
 * the successor recomputes. A mismatch does not keep the transition.
 * A consistent body is not a snapshot proof. Canonical evidence that does not
 * replay does not return. This is not a proof of the whole transition, and it
 * does not restart a process.
 */
import { describe, expect, it } from "vitest";
import { ChainState, admitRestoredBlock, buildChainFromBlocks } from "../chain/state.js";
import { merkleRoot } from "../chain/crypto.js";
import { orderRestoredRows, verifyBlockBody, RestoreIntegrityError } from "../chain/block-body.js";
import { replayCanonicalEvidence } from "../chain/evidence-restore.js";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { minerKey } from "../../../../site/src/protocol/genesis.js";
import { keypairFromSeed, signTx } from "../../../../site/src/protocol/wallet.js";
import type { BlockRecord, TxRecord } from "../chain/types.js";
import type { PersistBlockResult } from "../chain/persistence.js";

const miner = minerKey("mainnet").address;
const inserted: PersistBlockResult = { durable: true, outcome: "inserted" };
const zeros = "0".repeat(64);

function fresh(): ChainState {
  return new ChainState();
}

function fund(state: ChainState, address: string, amount: number): void {
  state.canonicalBody.omega.ledger.set(address, { balance: amount, nonce: 0 });
}

async function seal(state: ChainState, txs: TxRecord[] = []): Promise<BlockRecord> {
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

function payerTx(state: ChainState, seed = "equilibrium-restore-payer"): TxRecord {
  const payer = keypairFromSeed(seed);
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

function shell(partial: Partial<BlockRecord> & Pick<BlockRecord, "hash" | "merkleRoot" | "txCount" | "transactions">): BlockRecord {
  return {
    height: 0,
    prevHash: zeros,
    timestamp: 1_700_000_000,
    nonce: 1n,
    difficulty: 1_000_000,
    residual: 0,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    ...partial,
  };
}

describe("a restored body is the committed list, not a snapshot proof", () => {
  it("accepts an empty body only at the seal's zero root", () => {
    expect(merkleRoot([])).toBe(merkleRoot([zeros]));
    const empty = shell({ hash: "ab".repeat(32), merkleRoot: zeros, txCount: 0, transactions: [] });
    expect(verifyBlockBody(empty, 1)).toEqual({ ok: true });
    expect(verifyBlockBody({ ...empty, merkleRoot: "11".repeat(32) }, 1).ok).toBe(false);
  });

  it("a consistent body is not the successor identity", () => {
    const block = shell({ hash: "ab".repeat(32), merkleRoot: zeros, txCount: 0, transactions: [] });
    expect(verifyBlockBody(block, 1)).toEqual({ ok: true });
    expect(block.hash).not.toBe(zeros);
  });

  it("rejects a count, an order, and an even or odd merkle that is not the list", () => {
    const hashes = ["aa".repeat(32), "bb".repeat(32), "cc".repeat(32)];
    const txs = hashes.map((hash) => ({
      hash, from: "aa".repeat(20), to: "bb".repeat(20), amount: 1, fee: 0, nonce: 0,
      timestamp: 1, status: "confirmed" as const, blockHash: null, blockHeight: null,
    }));
    const even = shell({
      hash: "ab".repeat(32),
      merkleRoot: merkleRoot(hashes.slice(0, 2)),
      txCount: 2,
      transactions: txs.slice(0, 2),
    });
    const odd = shell({
      hash: "ab".repeat(32),
      merkleRoot: merkleRoot(hashes),
      txCount: 3,
      transactions: txs,
    });
    expect(verifyBlockBody(even, 1, { authenticate: false })).toEqual({ ok: true });
    expect(verifyBlockBody(odd, 1, { authenticate: false })).toEqual({ ok: true });
    expect(verifyBlockBody({ ...odd, txCount: 2 }, 1, { authenticate: false }).ok).toBe(false);
    const reordered = shell({
      hash: "ab".repeat(32),
      merkleRoot: odd.merkleRoot,
      txCount: 3,
      transactions: [txs[2]!, txs[0]!, txs[1]!],
    });
    const moved = verifyBlockBody(reordered, 1, { authenticate: false });
    expect(moved).toMatchObject({ ok: false, code: "merkle" });
  });

  it("rejects a missing signature and an altered field behind the same hash", () => {
    const origin = fresh();
    const tx = payerTx(origin);
    const block = shell({
      hash: "ab".repeat(32),
      merkleRoot: merkleRoot([tx.hash]),
      txCount: 1,
      transactions: [tx],
    });
    expect(verifyBlockBody(block, origin.canonicalBody.omega.chainId)).toEqual({ ok: true });
    const unsigned = verifyBlockBody({
      ...block,
      transactions: [{ ...tx, signature: undefined, publicKey: undefined }],
    }, origin.canonicalBody.omega.chainId);
    expect(unsigned).toMatchObject({ ok: false, code: "tx-auth" });
    const altered = verifyBlockBody({
      ...block,
      transactions: [{ ...tx, amount: tx.amount + 1 }],
    }, origin.canonicalBody.omega.chainId);
    expect(altered).toMatchObject({ ok: false, code: "tx-auth" });
  });

  it("does not recover an order the index does not state", () => {
    expect(orderRestoredRows([{ hash: "aa", txIndex: null }])).toEqual([{ hash: "aa", txIndex: null }]);
    expect(orderRestoredRows([
      { hash: "bb", txIndex: 1 },
      { hash: "aa", txIndex: 0 },
    ]).map((row) => row.hash)).toEqual(["aa", "bb"]);
    expect(() => orderRestoredRows([
      { hash: "aa", txIndex: null },
      { hash: "bb", txIndex: null },
    ])).toThrow(RestoreIntegrityError);
    expect(() => orderRestoredRows([
      { hash: "aa", txIndex: 0 },
      { hash: "bb", txIndex: 0 },
    ])).toThrow(/transaction order is not recoverable/);
    expect(() => orderRestoredRows([
      { hash: "aa", txIndex: 0 },
      { hash: "bb", txIndex: 2 },
    ])).toThrow(/transaction order is not recoverable/);
  });
});

describe("a restored successor must be the stored block", () => {
  it("replays an operational successor as that hash and keeps a non-successor unexecuted", async () => {
    const origin = fresh();
    const omega = origin.canonicalBody.omega;
    const outcome = await origin.commitOperational({
      hash: "11".repeat(32),
      height: omega.height + 1,
      prevHash: omega.tipHash,
      merkleRoot: zeros,
      timestamp: 1_700_000_000,
      nonce: 6n,
      difficulty: omega.difficulty,
      residual: 0,
      recursionDepth: 2,
      coinbaseReward: 0,
      miner,
      txCount: 0,
      transactions: [],
      committedPressure: 0,
    }, { persist: async () => inserted });
    expect(outcome.admitted, outcome.error).toBe(true);
    const sealed = origin.blocks[origin.blocks.length - 1];
    if (!sealed) throw new Error("operational seal missing");
    expect(sealed.evidence).toBeUndefined();
    const replayed = buildChainFromBlocks([sealed]);
    expect(replayed.canonicalBody.omega.tipHash).toBe(sealed.hash);
    expect(replayed.blocks.map((block) => block.hash)).toEqual([sealed.hash]);

    const other = shell({
      hash: "22".repeat(32),
      prevHash: "11".repeat(32),
      merkleRoot: zeros,
      txCount: 0,
      transactions: [],
    });
    const kept = buildChainFromBlocks([other]);
    expect(kept.canonicalBody.omega.height).toBe(-1);
    expect(kept.retainedBlocks.map((block) => block.hash)).toEqual([other.hash]);
  });

  it("does not keep a stored hash the successor did not recompute", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const beforeTip = copy.canonicalBody.omega.tipHash;
    const lied = { ...sealed, hash: "ab".repeat(32) };
    expect(() => admitRestoredBlock(copy, lied)).toThrow(/restored block identity mismatch/);
    expect(copy.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(copy.canonicalBody.omega.height).toBe(-1);
    expect(copy.blocks).toHaveLength(0);
    expect(copy.canonicalBody.blocks).toHaveLength(0);
  });

  it("does not move when the attached list is not the committed list", async () => {
    const origin = fresh();
    const tx = payerTx(origin);
    const sealed = await seal(origin, [tx]);
    const copy = fresh();
    fund(copy, tx.from, 50_000);
    const beforeTip = copy.canonicalBody.omega.tipHash;
    expect(() => admitRestoredBlock(copy, { ...sealed, transactions: [], txCount: 0 })).toThrow(/tx-count|merkle/);
    expect(copy.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(copy.blocks).toHaveLength(0);
  });

  it("names a failed restore instead of a clean refusal", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const host = copy as unknown as Record<string, unknown>;
    host.restoreTemporal = () => {
      throw new Error("restore exploded");
    };
    expect(() => admitRestoredBlock(copy, { ...sealed, hash: "ab".repeat(32) })).toThrow(
      /admission failed: restored block identity mismatch[\s\S]*restore failed: restore exploded/,
    );
  });
});

describe("canonical evidence that does not replay does not return", () => {
  it("refuses a bad body without moving, and a bad hash without keeping it", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    const beforeTip = copy.canonicalBody.omega.tipHash;
    await expect(replayCanonicalEvidence(copy, [{ ...sealed, txCount: 1, transactions: [] }])).rejects.toThrow(
      /canonical evidence replay failed/,
    );
    expect(copy.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(copy.blocks).toHaveLength(0);

    const again = fresh();
    await expect(replayCanonicalEvidence(again, [{ ...sealed, hash: "ab".repeat(32) }])).rejects.toThrow(
      /canonical evidence replay failed/,
    );
    expect(again.canonicalBody.omega.tipHash).toBe(beforeTip);
    expect(again.canonicalBody.blocks).toHaveLength(0);
  });

  it("keeps one sealed evidence block when the body and the hash both match", async () => {
    const sealed = await seal(fresh());
    const copy = fresh();
    await replayCanonicalEvidence(copy, [sealed]);
    expect(copy.canonicalBody.omega.tipHash).toBe(sealed.hash);
    expect(copy.getBlockByHash(sealed.hash)?.transactions).toEqual([]);
  });
});
