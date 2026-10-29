import assert from "node:assert/strict";
import { HELD_STATUS, heldRestore, mineInterval, networkMayMine } from "./restore-hold";

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

const ticks = { testnet: 0, mainnet: 0 };
const wrote: string[] = [];
mineInterval(
  { testnet: "double sign is not proved" },
  {
    testnet: { tick: () => { ticks.testnet += 1; return { height: 1 }; } },
    mainnet: { tick: () => { ticks.mainnet += 1; return null; } },
  },
  (network) => wrote.push(network),
);
assert.equal(ticks.testnet, 0);
assert.equal(ticks.mainnet, 1);
assert.deepEqual(wrote, []);

mineInterval(
  { mainnet: "statement is absent" },
  {
    testnet: { tick: () => { ticks.testnet += 1; return { height: 2 }; } },
    mainnet: { tick: () => { ticks.mainnet += 1; return { height: 9 }; } },
  },
  (network) => wrote.push(network),
);
assert.equal(ticks.testnet, 1);
assert.equal(ticks.mainnet, 1);
assert.deepEqual(wrote, ["testnet"]);

mineInterval(
  both,
  {
    testnet: { tick: () => { ticks.testnet += 1; return { height: 3 }; } },
    mainnet: { tick: () => { ticks.mainnet += 1; return { height: 4 }; } },
  },
  (network) => wrote.push(network),
);
assert.equal(ticks.testnet, 1);
assert.equal(ticks.mainnet, 1);
assert.deepEqual(wrote, ["testnet"]);

console.log("a refused restore is held, and only that network stops mining");

