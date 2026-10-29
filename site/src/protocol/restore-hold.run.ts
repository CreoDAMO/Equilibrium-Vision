import assert from "node:assert/strict";
import { heldRestore } from "./restore-hold";

const body = heldRestore("mainnet", "double sign is not proved", "neon", "10ecd05");
assert.equal(body.restored, false);
assert.equal(body.persisted, true);
assert.equal(body.reason, "double sign is not proved");
assert.equal(body.persistence, "neon");
assert.equal(body.deployment.commit, "10ecd05");
assert.equal("blocks" in body, false);

console.log("a refused restore is held, not replaced");
