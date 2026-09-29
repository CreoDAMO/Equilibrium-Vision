/**
 * The membrane: couplings, miner, pressure, residual fingerprint, nonce channel.
 */
import assert from "node:assert/strict";
import { residualsMatch } from "./crypto";
import {
  admittingNonces,
  applySuccessor,
  initialOmega,
  openedCouplings,
} from "./constitution";
import { dependencyFindings } from "./dependencies";
import { constitutionalAnswer } from "./constitution";

const born = initialOmega("mainnet");
born.height = 0;
born.tipTimestamp = 1_700_000_000;
const miners = [...born.validators.keys()];
const miner = miners[0]!;
const other = miners.find((k) => k !== miner)!;
const base = {
  transactions: [] as [],
  evidence: undefined,
  timestamp: born.tipTimestamp + 15,
  nonce: 6,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(born),
  difficulty: born.difficulty,
  wasmAfter: null,
};

const foreign = applySuccessor(born, { ...base, couplings: { ...base.couplings, structural: 0 } });
assert.equal(foreign.ok, false);
if (foreign.ok) throw new Error("foreign couplings were accepted");
assert.match(foreign.error, /couplings/);

const own = applySuccessor(born, base);
assert.equal(own.ok, true);
if (!own.ok) throw new Error(own.error);

const stranger = applySuccessor(born, { ...base, miner: "0".repeat(40) });
assert.equal(stranger.ok, false);
if (stranger.ok) throw new Error("stranger mined");
assert.match(stranger.error, /validator/);

const second = applySuccessor(born, { ...base, miner: other });
assert.equal(second.ok, true);
if (!second.ok) throw new Error(second.error);
assert.notEqual(second.omegaRoot, own.omegaRoot);

const wild = applySuccessor(born, { ...base, committedPressure: 2 });
assert.equal(wild.ok, false);
const early = applySuccessor(born, { ...base, timestamp: born.tipTimestamp - 1 });
assert.equal(early.ok, false);

const claimed = own.residual;
const nudged = claimed + 1e-15;
assert.equal(residualsMatch(claimed, nudged), false);
assert.ok(Math.abs(claimed - nudged) < 1e-12);
assert.equal(residualsMatch(claimed, claimed), true);

const admitted = admittingNonces(born, 4096, base.timestamp);
assert.ok(admitted.length >= 2, "need two admitting nonces");
const n1 = applySuccessor(born, { ...base, nonce: admitted[0]! });
const n2 = applySuccessor(born, { ...base, nonce: admitted[1]! });
assert.equal(n1.ok && n2.ok, true);
if (!n1.ok || !n2.ok) throw new Error("nonce");
assert.equal(n1.next.difficulty, n2.next.difficulty);
assert.deepEqual(n1.next.couplings, n2.next.couplings);
if (n1.reward !== n2.reward) assert.notEqual(n1.residual, n2.residual);

const answer = constitutionalAnswer();
assert.equal(answer.q1, true);
const deps = dependencyFindings();
const couplings = deps.find((row) => row.id === "couplings");
assert.equal(couplings?.verdict, "fixed");
const minerRow = deps.find((row) => row.id === "miner");
assert.match(minerRow?.detail ?? "", /refused/);

console.log(JSON.stringify({
  ok: true,
  q1: answer.q1,
  foreign: foreign.ok ? null : foreign.error,
  stranger: stranger.ok ? null : stranger.error,
  rootsDiffer: second.omegaRoot !== own.omegaRoot,
  nonces: admitted.slice(0, 2),
  rewards: [n1.reward, n2.reward],
  sameDifficulty: n1.next.difficulty === n2.next.difficulty,
}));
