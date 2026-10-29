import assert from "node:assert/strict";
import { HELD_STATUS, heldRestore, networkMayMine } from "./restore-hold";

const body = heldRestore("mainnet", "double sign is not proved", "neon", "10ecd05");
assert.equal(body.restored, false);
assert.equal(body.persisted, true);
assert.equal(body.reason, "double sign is not proved");
assert.equal(body.persistence, "neon");
assert.equal(body.deployment.commit, "10ecd05");
assert.equal("blocks" in body, false);
assert.equal(HELD_STATUS, 503);

const open = {};
assert.equal(networkMayMine(open, "testnet"), true);
assert.equal(networkMayMine(open, "mainnet"), true);
assert.equal(networkMayMine({ testnet: "double sign is not proved" }, "testnet"), false);
assert.equal(networkMayMine({ testnet: "double sign is not proved" }, "mainnet"), true);
assert.equal(networkMayMine({ mainnet: "statement is absent" }, "testnet"), true);
assert.equal(networkMayMine({ mainnet: "statement is absent" }, "mainnet"), false);
const both = { testnet: "double sign is not proved", mainnet: "statement is absent" };
assert.equal(networkMayMine(both, "testnet"), false);
assert.equal(networkMayMine(both, "mainnet"), false);

console.log("a refused restore is held, and only that network stops mining");
