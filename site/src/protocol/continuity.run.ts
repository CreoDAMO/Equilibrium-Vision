/**
 * Producer A stops. A second body, given only the blocks, produces the next one.
 * A third body accepts it. The Bitcoin tip is in that block, not in A's memory.
 *
 *   tsx site/src/protocol/continuity.run.ts
 */
import assert from "node:assert/strict";
import { BTC_GENESIS_HEADER_HEX } from "./btc";
import { OrganismNode } from "./chain";
import { NETWORKS } from "./networks";

function foreignNext(difficulty: number, blockTime: number, hash: string): number {
  const target = 8;
  const byte = Number.parseInt(hash.slice(-2), 16);
  const bump = Math.round((byte / 255) * 100);
  const num = 9950 + bump;
  const den = 10_000;
  const unclamped = (target / blockTime) * (num / den);
  const factor = Math.max(0.8, Math.min(1.2, unclamped));
  if (factor === 0.8 || factor === 1.2) return Math.max(100_000, Math.floor(difficulty * factor));
  return Math.max(100_000, Math.floor((difficulty * target * num) / (blockTime * den)));
}

const a = new OrganismNode("testnet");
const before = a.difficulty;
const tipBefore = a.tip;
assert.ok(tipBefore, "producer produced no tip");
const submitted = a.submitBtcHeader(BTC_GENESIS_HEADER_HEX, 0);
assert.equal(submitted.ok, true, submitted.error ?? "bitcoin genesis header refused");
const step = Math.max(1, Math.floor(NETWORKS.testnet.targetBlockTimeMs / 1000));
const btcBlock = a.mine(tipBefore.timestamp + step);
assert.equal(btcBlock.verified, true, btcBlock.verifyNotes.join("; ") || "btc block did not verify");
const btcTip = a.btcHeaders[a.btcHeaders.length - 1]?.hash ?? null;
assert.equal(btcTip, submitted.hash);
assert.ok(btcTip);
const armed = a.difficulty;
const expectedArmed = foreignNext(before, step, btcTip);
assert.equal(armed, expectedArmed, `foreign difficulty ${armed} is not ${expectedArmed}`);

const blocks = JSON.parse(JSON.stringify(a.blocks)) as typeof a.blocks;
const tipHash = a.tip!.hash;
const tipHeight = a.tip!.height;
const report = await OrganismNode.takeover("testnet", blocks);
assert.equal(report.ok, true, report.error ?? "takeover failed");
assert.equal(report.prevHash, tipHash);
assert.equal(report.height, tipHeight + 1);
assert.ok(report.residual < 2e-3, `residual ${report.residual} is not under 0.002`);
assert.equal(report.btcTip, btcTip);
assert.equal(report.stateRoot.length, 64);
assert.equal(report.difficulty, foreignNext(armed, step, btcTip));

const replay = await OrganismNode.become("testnet", blocks);
assert.equal(replay.ok, true, replay.error ?? "replay failed");
assert.equal(replay.height, tipHeight, "replay produced a block; that is not what become is for");
assert.ok(report.height === replay.height + 1);

const out = {
  ok: true,
  producerHeight: tipHeight,
  takeoverHeight: report.height,
  prevHash: report.prevHash,
  stateRoot: report.stateRoot,
  residual: report.residual,
  difficultyBeforeBtc: before,
  difficultyAfterBtc: armed,
  difficultyAfterTakeover: report.difficulty,
  btcTip,
  btcByte: Number.parseInt(btcTip.slice(-2), 16),
};
console.log(JSON.stringify(out));
process.exit(0);
