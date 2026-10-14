/**
 * External admission recomputes the successor.
 * A header that still hashes after its transition digest or omega digest is swapped is refused.
 *
 *   NODE_ENV=production tsx site/src/protocol/transition-bind.run.ts
 */
import assert from "node:assert/strict";
import { OrganismNode } from "./chain";
import { canonicalHeaderHash } from "./crypto";
import { evidenceRoot } from "./evidence";
import type { BlockRecord } from "./types";

function reseal(block: BlockRecord): BlockRecord {
  const next: BlockRecord = { ...block, relation: undefined };
  next.hash = canonicalHeaderHash({
    prevHash: next.prevHash,
    merkleRoot: next.merkleRoot,
    stateRoot: next.stateRoot,
    timestamp: next.timestamp,
    nonce: next.nonce,
    difficulty: next.difficulty,
    residualFp: next.residualFp,
    miner: next.miner,
    height: next.height,
    committedPressure: next.committedPressure,
    ...(next.evidence
      ? {
          chainId: next.evidence.chainId,
          evidenceRoot: evidenceRoot(next.evidence),
          omegaRoot: next.omegaRoot,
          ...(next.transitionRoot !== undefined ? { transitionRoot: next.transitionRoot } : {}),
        }
      : {}),
  });
  return next;
}

const node = new OrganismNode("testnet");
const parent = node.tip;
if (!parent) throw new Error("no parent");
const block = node.fork().mine(parent.timestamp + 12);
assert.match(block.transitionRoot ?? "", /^[0-9a-f]{64}$/);
assert.match(block.omegaRoot ?? "", /^[0-9a-f]{64}$/);

const holder = node.fork();
const honest = await holder.submitExternal(block);
assert.equal(honest.ok, true, honest.error);
const duplicate = await holder.submitExternal(block);
assert.equal(duplicate.ok, true, duplicate.error);
assert.equal(duplicate.report.ok, true);

const forged = await holder.submitExternal({ ...block, residual: 1e-12, residualFp: 0 });
assert.equal(forged.ok, false);
assert.match(forged.error ?? "", /already canonical, claim refused/);
assert.equal(holder.tip?.hash, block.hash);
assert.equal(holder.height, block.height);

const wrongTransition = reseal({ ...block, transitionRoot: "ab".repeat(32) });
const transition = await node.fork().submitExternal(wrongTransition);
assert.equal(transition.ok, false);
assert.match(transition.error ?? "", /transition is not this input/);

const wrongOmega = reseal({ ...block, omegaRoot: "cd".repeat(32) });
const omega = await node.fork().submitExternal(wrongOmega);
assert.equal(omega.ok, false);
assert.match(omega.error ?? "", /omega root does not replay/);

console.log(JSON.stringify({
  ok: true,
  honest: honest.ok,
  duplicate: duplicate.ok,
  forgedRefused: forged.error,
  transitionRefused: transition.error,
  omegaRefused: omega.error,
}));
