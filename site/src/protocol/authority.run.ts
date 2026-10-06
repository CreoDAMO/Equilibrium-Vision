/**
 * A-001 on the public stake and wasm doors.
 * A caller string is not authority. Slash is not a public caller action.
 * This does not close role binding, revocation, or the mobile validator.
 */
import assert from "node:assert/strict";
import { gateStakeAction, gateWasmCaller, signAuthority, signWasm } from "./authority";
import { keypairFromSeed } from "./wallet";

const alice = keypairFromSeed("authority-alice");
const bob = keypairFromSeed("authority-bob");
const claim = { op: "delegate" as const, chainId: 2, validator: "ab".repeat(20), amount: 1000 };
const proof = signAuthority(alice, claim);

assert.equal(gateStakeAction({ ...claim, address: alice.address }).ok, false);
assert.equal(gateStakeAction({ ...claim, ...proof }).ok, true);
assert.equal(gateStakeAction({ ...claim, ...proof, address: bob.address }).ok, false);
assert.equal(gateStakeAction({ ...claim, ...proof, amount: 1001 }).ok, false);
assert.equal(gateStakeAction({ ...claim, ...proof, op: "claim" }).ok, false);

const stolen = signAuthority(bob, claim);
assert.equal(gateStakeAction({ ...claim, address: alice.address, publicKey: bob.publicKey, signature: stolen.signature }).ok, false);

assert.equal(gateStakeAction({ op: "slash", chainId: 2, address: alice.address, ...signAuthority(alice, { op: "delegate", chainId: 2 }) }).ok, false);
assert.equal(gateStakeAction({ op: "slash", chainId: 2, publicKey: alice.publicKey, signature: proof.signature }).error, "slash is not a public caller action");

const wasm = signWasm(alice, 2, "pause");
assert.equal(gateWasmCaller({ method: "pause", chainId: 2, caller: alice.address, ...wasm }).ok, true);
assert.equal(gateWasmCaller({ method: "unpause", chainId: 2, caller: alice.address, ...wasm }).ok, false);
assert.equal(gateWasmCaller({ method: "init", chainId: 2, caller: "0".repeat(40) }).ok, false);

console.log("authority.run ok");
