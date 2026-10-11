/**
 * A gossip body keeps the transaction list it already carried.
 * Absence is an empty list. The receiver mempool is not a substitute.
 * This is not the phone header, and it is not the artifacts seal.
 * A live socket is not this test.
 */
import { describe, expect, it } from "vitest";
import { prepareGossipBlock } from "../chain/gossip-ingress.js";
import { canonicalResidual } from "../chain/canonical-residual.js";
import { merkleRoot } from "../chain/crypto.js";
import { CANONICAL_RESIDUAL_TARGET } from "@workspace/coinomics";

const couplings = { hash: 1, structural: 1, continuity: 1, mempool: 1, fees: 1 };
const miner = "ab".repeat(20);
const prev = "11".repeat(32);
const target = CANONICAL_RESIDUAL_TARGET;

function tx(hash: string, fee = 0) {
  return {
    hash,
    from: "aa".repeat(20),
    to: "bb".repeat(20),
    amount: 1,
    fee,
    nonce: 0,
    timestamp: 1,
  };
}

function searchAdmitting(merkle: string, txs: { hash: string; fee: number }[], pressure: number) {
  for (let nonce = 0n; nonce < 200_000n; nonce++) {
    const residual = canonicalResidual(
      { prevHash: prev, merkleRoot: merkle, timestamp: 1_700_000_000, nonce, difficulty: 1_000_000 },
      txs,
      { cumulativeWork: 1, mempoolPressure: pressure },
      couplings,
    );
    if (residual < target) return { nonce, residual };
  }
  throw new Error("no admitting nonce in the searched window");
}

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: "cd".repeat(32),
    height: 1,
    prevHash: prev,
    miner,
    nonce: 1,
    difficulty: 1_000_000,
    residual: 0,
    timestamp: 1_700_000_000,
    ...extra,
  };
}

describe("a gossip body keeps the transaction list it carried", () => {
  it("keeps a nonempty list whose merkle matches and whose residual admits", () => {
    const carried = tx("ab".repeat(32), 0);
    const merkle = merkleRoot([carried.hash]);
    const found = searchAdmitting(merkle, [{ hash: carried.hash, fee: 0 }], 0);
    const prepared = prepareGossipBlock(body({
      nonce: found.nonce,
      residual: found.residual,
      merkleRoot: merkle,
      transactions: [carried],
      txCount: 1,
      committedPressure: 0,
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.block.transactions.map((row) => row.hash)).toEqual([carried.hash]);
    expect(prepared.block.txCount).toBe(1);
    expect(prepared.block.merkleRoot).toBe(merkle);
    expect(prepared.block.committedPressure).toBe(0);
    expect(prepared.block.hash).toBe("cd".repeat(32));
  });

  it("treats a missing transaction list as empty and a missing pressure as zero", () => {
    const merkle = merkleRoot([]);
    const found = searchAdmitting(merkle, [], 0);
    const prepared = prepareGossipBlock(body({
      nonce: found.nonce,
      residual: found.residual,
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.block.transactions).toEqual([]);
    expect(prepared.block.txCount).toBe(0);
    expect(prepared.block.merkleRoot).toBe(merkle);
    expect(prepared.block.committedPressure).toBe(0);
  });

  it("keeps a committed pressure small enough to admit, and does not replace it", () => {
    const merkle = merkleRoot([]);
    const pressure = 0.02;
    const found = searchAdmitting(merkle, [], pressure);
    const prepared = prepareGossipBlock(body({
      nonce: found.nonce,
      residual: found.residual,
      committedPressure: pressure,
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.block.transactions).toEqual([]);
    expect(prepared.block.committedPressure).toBe(pressure);
  });

  it("refuses a named hash list when the transactions themselves are absent", () => {
    const prepared = prepareGossipBlock(body({
      txHashes: ["ab".repeat(32)],
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    expect(prepared).toEqual({ ok: false, error: "transactions are not on this body" });
  });

  it("refuses a txCount that is not the list length", () => {
    const prepared = prepareGossipBlock(body({
      transactions: [tx("ab".repeat(32))],
      txCount: 0,
      merkleRoot: "ab".repeat(32),
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    expect(prepared).toEqual({ ok: false, error: "txCount is not the transaction set" });
  });

  it("refuses a merkle root that is not the carried list", () => {
    const prepared = prepareGossipBlock(body({
      transactions: [tx("ab".repeat(32))],
      txCount: 1,
      merkleRoot: "cd".repeat(32),
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    expect(prepared).toEqual({ ok: false, error: "merkle root is not the transaction set" });
  });

  it("refuses pressure outside the committed range", () => {
    const prepared = prepareGossipBlock(body({
      committedPressure: 2,
      transactions: [],
    }), { difficulty: 1_000_000, couplings, admissionTarget: target });
    expect(prepared).toEqual({ ok: false, error: "committed pressure is block evidence" });
  });

  it("refuses a difficulty that is not the canonical difficulty", () => {
    const prepared = prepareGossipBlock(body({ difficulty: 2 }), {
      difficulty: 1_000_000,
      couplings,
      admissionTarget: target,
    });
    expect(prepared).toEqual({ ok: false, error: "difficulty is not the canonical difficulty" });
  });
});
