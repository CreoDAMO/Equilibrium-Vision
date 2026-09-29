/**
 * Two admissible blocks, same parent. The lower residualFp wins, even if it arrives second.
 * Equal weight: the smaller tip hash wins. Arrival is not the rule.
 */
import assert from "node:assert/strict";
import { OrganismNode } from "./chain";
import { chainWeight, preferChain } from "./frontier";

assert.equal(preferChain({ weight: 1n, tipHash: "b" }, { weight: 2n, tipHash: "a" }), true);
assert.equal(preferChain({ weight: 2n, tipHash: "a" }, { weight: 2n, tipHash: "b" }), true);
assert.equal(preferChain({ weight: 2n, tipHash: "b" }, { weight: 2n, tipHash: "a" }), false);

const node = new OrganismNode("testnet");
const parent = node.tip!;
const left = node.fork();
const right = node.fork();
const a = left.mine(parent.timestamp + 1);
const b = right.mine(parent.timestamp + 30);
assert.equal(a.prevHash, parent.hash);
assert.equal(b.prevHash, parent.hash);
assert.notEqual(a.hash, b.hash);

const wa = chainWeight([a]);
const wb = chainWeight([b]);
const winner = preferChain({ weight: wa, tipHash: a.hash }, { weight: wb, tipHash: b.hash }) ? a : b;
const first = wa >= wb ? a : b;
const second = first === a ? b : a;

const admittedFirst = await node.submitExternal(first);
assert.equal(admittedFirst.ok, true, admittedFirst.error);
assert.equal(node.tip?.hash, first.hash);

const admittedSecond = await node.submitExternal(second);
assert.equal(node.tip?.hash, winner.hash, admittedSecond.error ?? "tip did not follow EQ-09");
assert.equal(node.blocks.filter((block) => block.hash === winner.hash).length, 1);
if (winner.hash !== first.hash) assert.equal(admittedSecond.ok, true, admittedSecond.error);

console.log(JSON.stringify({
  ok: true,
  first: first.hash.slice(0, 16),
  second: second.hash.slice(0, 16),
  winner: winner.hash.slice(0, 16),
  weights: [wa.toString(), wb.toString()],
  reorg: winner.hash !== first.hash,
  height: node.height,
}));
