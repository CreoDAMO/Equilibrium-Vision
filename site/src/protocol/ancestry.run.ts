/**
 * The chain roots at genesis. A repeated block that names another predecessor is not canonical.
 */
import assert from "node:assert/strict";
import { ancestryBreak, genesisStateId } from "./ancestry";
import { OrganismNode } from "./chain";

const node = new OrganismNode("testnet");
const root = genesisStateId("testnet");
assert.equal(ancestryBreak(node.blocks, root), null);
assert.equal(node.blocks[0]?.statement?.predecessor, root);
assert.notEqual(node.blocks[1]?.statement?.predecessor, root);

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
