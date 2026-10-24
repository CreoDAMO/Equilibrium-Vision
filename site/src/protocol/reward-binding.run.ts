/**
 * The carried second block does not use the zero-parent header.
 * The reward proof's header binds only to the predecessor that produced it.
 */
import assert from "node:assert/strict";
import { initialOmega, openedCouplings, successor } from "./constitution";
import { minerKey } from "./genesis";
import { blankEvidence, sealFromSuccessor } from "./seal";
import { evaluateCtp1 } from "./ctp1";
import { omegaDigest } from "./constitution";
import { statementId, transitionStatement } from "./transition-proof";
import {
  contextIdBinds,
  inputIdBinds,
  predecessorBinds,
  residualPreimage,
  rewardHeaderBinds,
  statementIdBinds,
} from "./reward-binding";

function inputs(before: ReturnType<typeof initialOmega>, timestamp: number) {
  return {
    transactions: [],
    evidence: blankEvidence(before.chainId),
    timestamp,
    nonce: 1n,
    miner: minerKey("mainnet").address,
    committedPressure: 0,
    couplings: openedCouplings(before),
    difficulty: before.difficulty,
  };
}

const genesis = initialOmega("mainnet");
const firstIn = inputs(genesis, genesis.tipTimestamp + 12);
const first = await successor(genesis, firstIn);
assert.equal(first.ok, true);
if (!first.ok) throw new Error(first.error);
const sealed = sealFromSuccessor(genesis, { ...firstIn, wasmAfter: null }, first);

const carriedIn = inputs(sealed.carried, sealed.carried.tipTimestamp + 12);
const carried = await evaluateCtp1({ before: sealed.carried, inputs: carriedIn });
assert.equal(carried.ok, true);
if (!carried.ok) throw new Error(carried.reason);

const carriedHeader = residualPreimage(sealed.carried, carriedIn);
assert.equal(rewardHeaderBinds(sealed.carried, { ...carriedIn, wasmAfter: null }, carriedHeader), true);
const flipped = new Uint8Array(carriedHeader);
flipped[0] ^= 1;
assert.equal(rewardHeaderBinds(sealed.carried, { ...carriedIn, wasmAfter: null }, flipped), false);

const zeroParent = new Uint8Array(80);
zeroParent.set(new Uint8Array(new BigUint64Array([24n]).buffer), 64);
zeroParent.set(new Uint8Array(new BigUint64Array([1n]).buffer), 72);
assert.equal(rewardHeaderBinds(sealed.carried, { ...carriedIn, wasmAfter: null }, zeroParent), false);

const uncarriedIn = inputs(first.next, first.next.tipTimestamp + 12);
const uncarriedHeader = residualPreimage(first.next, uncarriedIn);
assert.equal(rewardHeaderBinds(first.next, { ...uncarriedIn, wasmAfter: null }, zeroParent), true);
assert.notEqual(Buffer.from(carriedHeader).toString("hex"), Buffer.from(uncarriedHeader).toString("hex"));

assert.equal(predecessorBinds(sealed.carried, carried.statement), true);
assert.notEqual(carried.statement.predecessor, omegaDigest(sealed.carried));
assert.equal(inputIdBinds({ ...carriedIn, wasmAfter: null }, carried.statement), true);
assert.equal(contextIdBinds(sealed.carried, carried.statement), true);
assert.equal(statementIdBinds(carried.statement, carried.statementId), true);
assert.equal(statementIdBinds(carried.statement, "801861c38e8d596fdc42b6e6d63ac2dae0941f723dd9083415fad7240b2aef30"), false);

const renamed = { ...carried.statement, predecessor: "00".repeat(32) };
assert.notEqual(statementId(renamed), carried.statementId);
assert.notEqual(carried.statement.header, Buffer.from(carriedHeader).toString("hex"));

const again = transitionStatement(sealed.carried, { ...carriedIn, wasmAfter: null }, carried.stepped, sealFromSuccessor(sealed.carried, { ...carriedIn, wasmAfter: null }, carried.stepped));
assert.equal(statementId(again), carried.statementId);
assert.equal(carried.stepped.reward, 2);
assert.equal(carried.stepped.liquid, 0);

console.log("reward header binds to the carried predecessor only");
console.log(carried.statementId);
