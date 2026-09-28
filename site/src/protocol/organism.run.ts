/**
 * One slash-bearing successor, sealed the same way on both bodies.
 * omegaDigest does not include tipHash. The carried Ω does.
 * Run: node --experimental-strip-types is not enough; use tsx.
 */
import assert from "node:assert/strict";
import { canonicalHeaderHash as artifactsHeaderHash } from "../../../artifacts/api-server/src/chain/crypto";
import { CanonicalBody } from "../../../artifacts/api-server/src/chain/canonical-body";
import { BTC_GENESIS_HEADER_HEX } from "./btc";
import { successor, omegaDigest } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import { ethKeygen, hexOf, signEthHeader } from "./eth-light";
import { minerKey } from "./genesis";
import { omegaRecord, sealFromSuccessor } from "./seal";
import type { TransitionEvidence } from "./types";

async function main() {
const miner = minerKey("mainnet").address;
const kernel = new CanonicalBody("mainnet");
const victim = [...kernel.omega.validators.values()].find((v) => v.address !== miner);
assert.ok(victim, "a validator other than the miner exists");
const bondedBefore = victim.bondedStake;

const key = ethKeygen();
const fields = {
  slot: 7,
  proposerIndex: 3,
  parentRoot: "11".repeat(32),
  stateRoot: "22".repeat(32),
  bodyRoot: "33".repeat(32),
};
const evidence: TransitionEvidence = {
  v: 1,
  chainId: kernel.omega.chainId,
  wasmCode: ARBITRAGE_CODE,
  btc: [{ headerHex: BTC_GENESIS_HEADER_HEX, height: 0 }],
  eth: [
    { op: "bootstrap", pubkey: hexOf(key.pubkey) },
    { op: "header", ...fields, participants: 342, signature: hexOf(signEthHeader(key.secret, fields)) },
  ],
  wasm: [{ method: "init", caller: miner }],
  stake: [{ op: "slash", validator: victim.address, reason: "double_sign" }],
};
const inputs = {
  transactions: [],
  evidence,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: { ...kernel.omega.couplings },
  difficulty: kernel.omega.difficulty,
};

const previousTip = kernel.omega.tipHash;
const stepped = await successor(kernel.omega, inputs);
assert.equal(stepped.ok, true);
if (!stepped.ok) throw new Error(stepped.error);
const sealed = sealFromSuccessor(kernel.omega, { ...inputs, wasmAfter: null }, stepped);
const digestView = omegaRecord(sealed.digestOmega);
const carriedView = omegaRecord(sealed.carried);

assert.equal(sealed.digestOmega.tipHash, previousTip);
assert.equal(sealed.carried.tipHash, sealed.hash);
assert.notEqual(carriedView.tipHash, digestView.tipHash);
assert.equal(omegaDigest(sealed.digestOmega), omegaDigest(sealed.carried));
assert.equal(digestView.omegaRoot, carriedView.omegaRoot);

const artifact = new CanonicalBody("mainnet");
const committed = await artifact.commit(inputs);
assert.equal(committed.ok, true);
if (!committed.ok) throw new Error(committed.error);

assert.deepEqual(committed.record, carriedView);
assert.equal(committed.hash, sealed.hash);
assert.equal(committed.tipHash, sealed.hash);
assert.equal(committed.omegaRoot, stepped.omegaRoot);

const slashed = committed.record.validators.find((v) => v.address === victim.address);
assert.ok(slashed);
assert.equal(slashed.slashed, true);
assert.equal(slashed.jailed, true);
assert.equal(slashed.bondedStake, bondedBefore - Math.floor(bondedBefore * 0.05));
assert.equal(committed.record.wasm.length > 0, true);
assert.equal(committed.record.btc.length, 1);
assert.equal(committed.record.eth.length, 1);
assert.equal(committed.record.ethPubkey.length, 96);

const again = artifactsHeaderHash({
  prevHash: previousTip,
  merkleRoot: committed.merkleRoot,
  stateRoot: committed.stateRoot,
  timestamp: inputs.timestamp,
  nonce: inputs.nonce,
  difficulty: inputs.difficulty,
  residualFp: committed.residualFp,
  miner,
  height: committed.height,
  committedPressure: 0,
  chainId: evidence.chainId,
  evidenceRoot: committed.evidenceRoot,
  omegaRoot: committed.omegaRoot,
});
assert.equal(again, sealed.hash);

const replay = new CanonicalBody("mainnet");
const err = await replay.replay({
  hash: committed.hash,
  evidence: committed.evidence,
  transactions: [],
  timestamp: inputs.timestamp,
  nonce: inputs.nonce,
  miner,
  difficulty: inputs.difficulty,
  committedPressure: 0,
  stateRoot: committed.stateRoot,
  omegaRoot: committed.omegaRoot,
});
assert.equal(err, null);
assert.deepEqual(omegaRecord(replay.omega), carriedView);

const keys = Object.keys(carriedView);
for (const key of keys) {
  assert.deepEqual(
    committed.record[key as keyof typeof committed.record],
    carriedView[key as keyof typeof carriedView],
    key,
  );
}

console.log(JSON.stringify({
  ok: true,
  fields: keys,
  hash: sealed.hash,
  omegaRoot: stepped.omegaRoot,
  tipHash: sealed.carried.tipHash,
  previousTip,
  digestOmitsTip: digestView.tipHash !== carriedView.tipHash,
  bondedBefore,
  bondedAfter: slashed.bondedStake,
  jailed: slashed.jailed,
  wasm: committed.record.wasm,
  difficulty: committed.record.difficulty,
  finalizedHeight: committed.record.finalizedHeight,
  reward: committed.reward,
}));
}

main();
