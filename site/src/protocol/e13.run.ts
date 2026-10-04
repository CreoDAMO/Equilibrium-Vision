/**
 * E13. Pressure is committed evidence.
 * The receiver's mempool does not enter G or verification.
 */
import assert from "node:assert/strict";
import { OrganismNode } from "./chain";
import { applySuccessor } from "./constitution";
import { asBlockNonce } from "./domain";
import { verifyStationaryEvidence } from "./verify";
import { signTx } from "./wallet";

const quiet = new OrganismNode("testnet");
const at = quiet.tip!.timestamp + 1;
const observed = quiet.mempoolPressure;
const block = quiet.mine(at);
assert.equal(block.committedPressure, observed);
assert.notEqual(quiet.mempoolPressure, observed);

const crowded = quiet.fork();
const payer = crowded.actors[0]!;
for (let i = 0; i < 8; i++) {
  const tx = signTx(payer, {
    to: `${i.toString(16).padStart(40, "ab")}`,
    amount: 1,
    fee: 1,
    nonce: crowded.getAccount(payer.address).nonce + i,
    chainId: crowded.params.chainId,
    timestamp: at,
  });
  const submitted = crowded.submitTx(tx);
  assert.equal(submitted.ok, true, submitted.error);
}
assert.ok(crowded.mempoolPressure > 0);
assert.notEqual(crowded.mempoolPressure, block.committedPressure);

const parent = quiet.blocks[quiet.blocks.length - 2] ?? null;
const seen = verifyStationaryEvidence({
  block,
  prev: parent,
  cumulativeWork: block.height,
  params: quiet.params,
});
assert.equal(seen.ok, true, seen.checks.filter((c) => !c.ok).map((c) => c.name).join(","));
const substituted = verifyStationaryEvidence({
  block: { ...block, committedPressure: crowded.mempoolPressure },
  prev: parent,
  cumulativeWork: block.height,
  params: quiet.params,
});
assert.equal(substituted.ok, false);

const omega = quiet.toOmega();
const inputs = {
  transactions: [] as [],
  evidence: undefined,
  timestamp: block.timestamp + 1,
  nonce: asBlockNonce(block.nonce),
  miner: block.miner,
  couplings: block.couplings,
  difficulty: omega.difficulty,
};
const atZero = applySuccessor(omega, { ...inputs, committedPressure: 0 });
const atOne = applySuccessor(omega, { ...inputs, committedPressure: 1 });
assert.equal(atZero.ok, true);
assert.equal(atOne.ok, true);
if (!atZero.ok || !atOne.ok) throw new Error("successor");
assert.notEqual(atZero.residualFp, atOne.residualFp);

console.log(JSON.stringify({
  ok: true,
  sealed: block.committedPressure,
  afterMine: quiet.mempoolPressure,
  receiverPool: crowded.mempoolPressure,
  verificationUsedCommitted: seen.ok && !substituted.ok,
  pressureChangesResidual: atZero.residualFp !== atOne.residualFp,
}));
