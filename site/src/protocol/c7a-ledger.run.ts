/**
 * Pins for the C7-A mutation ledger at this checkpoint.
 * These are observations of the current relation. They are not a proof.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gateStakeAction } from "./authority";
import { applySuccessor, cloneOmega, initialOmega, monetaryError, omegaDigest, stateRootOf } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { blankEvidence } from "./seal";

const omega = initialOmega("testnet");
const miner = omega.validators.keys().next().value as string;
const base = {
  transactions: [],
  timestamp: 15,
  nonce: 0n,
  miner,
  committedPressure: 0,
  couplings: { ...omega.couplings },
  difficulty: omega.difficulty,
  wasmAfter: null,
};

const stepped = applySuccessor(omega, base);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error("genesis step");

const digest = omegaDigest(stepped.next);
const moved = cloneOmega(stepped.next);
moved.tipHash = "ab".repeat(32);
assert.equal(omegaDigest(moved), digest);
assert.notEqual(moved.tipHash, stepped.next.tipHash);

const renamed = cloneOmega(stepped.next);
const pool = renamed.pools[0];
assert.ok(pool);
pool.tokenA = "NOPE";
assert.equal(omegaDigest(renamed), omegaDigest(stepped.next));
assert.equal(stateRootOf(renamed), stateRootOf(stepped.next));

const producer = stepped.next.validators.get(miner);
assert.ok(producer);
const distributed = omegaDigest(stepped.next);
producer.blocksProposed -= 1;
assert.notEqual(omegaDigest(stepped.next), distributed);
assert.equal(stateRootOf(stepped.next), stepped.stateRoot);

const unsafe = cloneOmega(omega);
const first = unsafe.ledger.keys().next().value as string;
const account = unsafe.ledger.get(first);
assert.ok(account);
account.nonce = Number.MAX_SAFE_INTEGER + 1;
assert.equal(monetaryError(unsafe), "balance refused");

const wasmRefused = applySuccessor(omega, {
  ...base,
  evidence: { ...blankEvidence(omega.chainId), wasm: [{ method: "pause", caller: miner }] },
});
assert.equal(wasmRefused.ok, false);
if (wasmRefused.ok) throw new Error("wasm");
assert.equal(wasmRefused.error, "wasm is executed by the successor");
assert.equal(ARBITRAGE_CODE.length, 64);

assert.equal(
  gateStakeAction({ op: "slash", chainId: omega.chainId, publicKey: "ab".repeat(32), signature: "cd".repeat(64) }).error,
  "slash is not a public caller action",
);

const chain = readFileSync(new URL("./chain.ts", import.meta.url), "utf8");
const api = readFileSync(new URL("../lib/chain-api.ts", import.meta.url), "utf8");
assert.equal(chain.includes("node.slash"), false);
assert.equal(api.includes("node.slash"), false);
assert.match(chain, /private async absorb\(block: BlockRecord\)/);
assert.match(chain, /const stepped = await successor\(this\.toOmega\(\)/);
assert.match(chain, /this\.pending = this\.blankEvidence\(\)/);
assert.match(chain, /applySuccessor\(omega,/);
