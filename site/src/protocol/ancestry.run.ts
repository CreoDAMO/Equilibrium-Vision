/**
 * The chain roots at genesis. A repeated block that names another predecessor is not canonical.
 */
import assert from "node:assert/strict";
import { ancestryBreak, genesisStateId } from "./ancestry";
import { OrganismNode } from "./chain";
import { statementAgrees } from "./transition-proof";

const node = new OrganismNode("testnet");
const root = genesisStateId("testnet");
assert.equal(ancestryBreak(node.blocks, root), null);
assert.equal(node.blocks[0]?.statement?.predecessor, root);
assert.notEqual(node.blocks[1]?.statement?.predecessor, root);
const live = node.blocks[1]?.statement;
if (!live) throw new Error("statement is absent");
const replay = {
  predecessor: live.predecessor,
  inputId: live.inputId,
  contextId: live.contextId,
  stateRoot: live.stateRoot,
  stateRootStateId: live.stateRootStateId,
  omegaRoot: live.omegaRoot,
  successor: live.successor,
  carried: live.carried,
  evidenceRoot: live.evidenceRoot,
  transitionRoot: live.transitionRoot,
  header: live.header,
  residualFp: Number(live.residualFp),
};
assert.equal(statementAgrees(live, replay, live.header), null);
assert.equal(live.v1, "faithful-v1");
assert.equal(statementAgrees({ ...live, v1: "stronger" as "faithful-v1" }, replay, live.header), "relation is not v1");
assert.equal(statementAgrees({ ...live, version: 2 as 1 }, replay, live.header), "statement version is not this relation");
assert.equal(statementAgrees({ ...live, wasm: "0" }, replay, live.header), "wasm is not this program");

const broken = node.blocks.map((block, index) =>
  index === 2 && block.statement
    ? { ...block, statement: { ...block.statement, predecessor: "0".repeat(64) } }
    : block,
);
assert.equal(ancestryBreak(broken, root), "predecessor is not the carried chain");

const claimed = node.blocks[2]!;
const tampered = {
  ...claimed,
  statement: claimed.statement && { ...claimed.statement, predecessor: "0".repeat(64) },
};
const refused = await node.submitExternal(tampered);
assert.equal(refused.ok, false);
assert.equal(refused.error, "statement is not the canonical block");
assert.equal(node.blocks[2]?.statement?.predecessor, claimed.statement?.predecessor);
assert.equal(node.height, 8);

console.log("ancestry roots at genesis and refuses a substituted predecessor");
