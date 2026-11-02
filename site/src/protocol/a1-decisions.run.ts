import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applySuccessor, cloneOmega, initialOmega, openedCouplings, slashAuthorization, successor } from "./constitution";
import { minerKey } from "./genesis";
import { blankEvidence } from "./seal";
import {
  A1_COMPOSITION_TARGET,
  A1_DC2,
  A1_DC6,
  A1_DC9_2,
  A1_NOT_DC6_RELEASE,
  A1_RESIDUALS,
} from "./a1-decisions";
import { ADOPTION_REQUIRES_TRANSITION_PROOF, verifyTransitionProof } from "./transition-proof";
import type { CanonicalInputs, Omega } from "./constitution";

assert.equal(A1_COMPOSITION_TARGET, "site-and-api-server");
assert.equal(A1_DC9_2.status, "closed-at-declared-scope");
assert.equal(A1_RESIDUALS.length, 3);
assert.equal(new Set(A1_DC2.map((row) => row.trust)).size, 6);
assert.equal(A1_DC2.every((row) => row.decision === "BIND-effect"), true);
const dc6 = new Set<string>([...A1_DC6.map((row) => row.id), ...A1_NOT_DC6_RELEASE]);
assert.equal(dc6.size, A1_DC6.length + A1_NOT_DC6_RELEASE.length);
assert.equal(ADOPTION_REQUIRES_TRANSITION_PROOF, false);
assert.equal(verifyTransitionProof({ version: 1 } as never, null).ok, false);

assert.equal(slashAuthorization("downtime"), "downtime is not punishable");
assert.equal(slashAuthorization("double_sign"), "double sign is not proved");
assert.equal(slashAuthorization("other"), "slash reason refused");

const api = readFileSync(new URL("../../../artifacts/api-server/src/chain/state.ts", import.meta.url), "utf8");
assert.equal(api.includes('error: "slash is stake evidence inside the successor, not a local write"'), true);

const miner = minerKey("mainnet").address;
const stranger = "ab".repeat(20);

function inputs(current: Omega, evidence = blankEvidence(current.chainId)): CanonicalInputs {
  return {
    transactions: [],
    evidence,
    timestamp: current.tipTimestamp + 1,
    nonce: 1n,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter: null,
  };
}

const omega = initialOmega("mainnet");
const bonded = omega.validators.get(miner)?.bondedStake;
const slashed = applySuccessor(omega, inputs(omega, {
  ...blankEvidence(omega.chainId),
  stake: [{ op: "slash", validator: miner, reason: "downtime" }],
}));
assert.equal(slashed.ok, false);
if (slashed.ok) throw new Error("slash");
assert.equal(slashed.error, "downtime is not punishable");
assert.equal(omega.validators.get(miner)?.bondedStake, bonded);

const funded = cloneOmega(omega);
const row = funded.validators.get(miner);
if (!row) throw new Error("miner");
row.accumulatedRewards = 5;
const before = funded.ledger.get(miner)?.balance ?? 0;
const claimed = applySuccessor(funded, inputs(funded, {
  ...blankEvidence(funded.chainId),
  stake: [{ op: "claim", address: miner }],
}));
assert.equal(claimed.ok, true);
if (!claimed.ok) throw new Error(claimed.error);
assert.equal(claimed.next.validators.get(miner)?.accumulatedRewards, 0);
assert.equal(claimed.next.ledger.get(miner)?.balance, before + 5);
const otherClaim = applySuccessor(funded, inputs(funded, {
  ...blankEvidence(funded.chainId),
  stake: [{ op: "claim", address: stranger }],
}));
assert.equal(otherClaim.ok, false);

const proposed = applySuccessor(omega, inputs(omega, {
  ...blankEvidence(omega.chainId),
  stake: [{ op: "propose", proposer: miner, title: "boundary", deposit: 1, id: 7 }],
}));
assert.equal(proposed.ok, true);
if (!proposed.ok) throw new Error(proposed.error);
assert.equal(proposed.next.proposals.some((p) => p.id === 7 && p.proposer === miner), true);
assert.equal(proposed.next.ledger.get(miner)?.balance, (omega.ledger.get(miner)?.balance ?? 0) - 1);
const strangerProposal = applySuccessor(omega, inputs(omega, {
  ...blankEvidence(omega.chainId),
  stake: [{ op: "propose", proposer: stranger, title: "no", deposit: 1, id: 8 }],
}));
assert.equal(strangerProposal.ok, false);
if (strangerProposal.ok) throw new Error("stranger propose");
assert.equal(strangerProposal.error, "proposal proposer unauthorized");

const voted = applySuccessor(omega, inputs(omega, {
  ...blankEvidence(omega.chainId),
  stake: [
    { op: "propose", proposer: miner, title: "tally", deposit: 1, id: 9 },
    { op: "vote", voter: miner, id: 9, option: "yes" },
  ],
}));
assert.equal(voted.ok, true);
if (!voted.ok) throw new Error(voted.error);
const proposal = voted.next.proposals.find((p) => p.id === 9);
assert.equal(proposal?.yes, bonded);
const strangerVote = applySuccessor(omega, inputs(omega, {
  ...blankEvidence(omega.chainId),
  stake: [
    { op: "propose", proposer: miner, title: "tally", deposit: 1, id: 9 },
    { op: "vote", voter: stranger, id: 9, option: "yes" },
  ],
}));
assert.equal(strangerVote.ok, false);

async function step(current: Omega, evidence: ReturnType<typeof blankEvidence>) {
  const full = inputs(current, evidence);
  const { wasmAfter: _ignored, ...rest } = full;
  return successor(current, rest);
}

const initialized = await step(cloneOmega(omega), { ...blankEvidence(omega.chainId), wasm: [{ method: "init", caller: miner }] });
assert.equal(initialized.ok, true);
if (!initialized.ok) throw new Error(initialized.error);
assert.equal(initialized.next.wasm.get("owner"), miner);
const refusedPause = await step(initialized.next, {
  ...blankEvidence(initialized.next.chainId),
  wasm: [{ method: "pause", caller: stranger }],
});
assert.equal(refusedPause.ok, false);
const paused = await step(initialized.next, {
  ...blankEvidence(initialized.next.chainId),
  wasm: [{ method: "pause", caller: miner }],
});
assert.equal(paused.ok, true);
if (!paused.ok) throw new Error(paused.error);
assert.equal(paused.next.wasm.get("paused"), "1");
const unpaused = await step(paused.next, {
  ...blankEvidence(paused.next.chainId),
  wasm: [{ method: "unpause", caller: miner }],
});
assert.equal(unpaused.ok, true);
if (!unpaused.ok) throw new Error(unpaused.error);
assert.equal(unpaused.next.wasm.get("paused"), "0");
assert.notEqual(unpaused.next.wasm.get("paused"), paused.next.wasm.get("paused"));

console.log("a1 decisions match the site and api-server relation");
