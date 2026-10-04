/**
 * S6 λ attacks. Site computes the residual. Rust recomputes it.
 * The oracle is that execution, not a hand-written expected column.
 * Successor, transitionRoot, and Ω′ are not this file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialOmega, openedCouplings } from "./constitution";
import { evaluateResidual } from "./solver";
import { DEFAULT_COUPLINGS, type Couplings } from "./types";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const zeros = "00".repeat(32);
const axes = ["hash", "structural", "continuity", "mempool", "fees"] as const;

function header(nonce: number) {
  return { prevHash: zeros, merkleRoot: zeros, timestamp: 1_700_000_000, nonce, difficulty: 1_000_000 };
}

function measure(nonce: number, work: number, pressure: number, lambda: Couplings, fee = 0) {
  const txs = fee === 0 ? [] : [{ hash: "ab".repeat(32), fee }];
  return {
    txs,
    got: evaluateResidual(header(nonce), txs, { cumulativeWork: work, mempoolPressure: pressure }, lambda),
  };
}

let hashNonce = -1;
for (let nonce = 0; nonce < 20_000; nonce++) {
  const sample = measure(nonce, 1, 0, DEFAULT_COUPLINGS).got;
  if (sample.violations.hash > 0 && sample.violations.structural > 0) {
    hashNonce = nonce;
    break;
  }
}
assert.ok(hashNonce >= 0, "no nonce with a live hash violation");

const base = measure(hashNonce, 1, 0, DEFAULT_COUPLINGS).got;
for (const axis of axes) {
  const dropped = { ...DEFAULT_COUPLINGS, [axis]: 0 };
  const got = measure(hashNonce, 1, 0, dropped).got;
  const delta = base.canonical - got.canonical;
  assert.ok(Math.abs(delta - base.violations[axis] ** 2) < 1e-12, `${axis} delta ${delta}`);
}

const withWork = measure(hashNonce, 0, 0, DEFAULT_COUPLINGS).got;
const withoutContinuity = measure(hashNonce, 0, 0, { ...DEFAULT_COUPLINGS, continuity: 0 }).got;
assert.ok(Math.abs(withWork.canonical - withoutContinuity.canonical - 1) < 1e-12, "continuity");

const pressured = measure(hashNonce, 1, 0.5, DEFAULT_COUPLINGS, 0);
const dropMem = measure(hashNonce, 1, 0.5, { ...DEFAULT_COUPLINGS, mempool: 0 }, 0).got;
const dropFee = measure(hashNonce, 1, 0.5, { ...DEFAULT_COUPLINGS, fees: 0 }, 0).got;
assert.ok(Math.abs(pressured.got.violations.mempool - 0.5) < 1e-12);
assert.ok(Math.abs(pressured.got.violations.fees - 0.5) < 1e-12);
assert.ok(Math.abs(pressured.got.canonical - dropMem.canonical - 0.25) < 1e-12, "mempool");
assert.ok(Math.abs(pressured.got.canonical - dropFee.canonical - 0.25) < 1e-12, "fees");

const quiet = measure(6, 1, 0, { hash: 0, structural: 0, continuity: 0, mempool: 0, fees: 0 }).got;
const loud = measure(6, 1, 0, DEFAULT_COUPLINGS).got;
assert.equal(quiet.canonical, 0);
assert.ok(loud.canonical > 0);
assert.equal(loud.canonicalFp, 201_100_202_523_998);

const heavy = measure(hashNonce, 1, 0, { ...DEFAULT_COUPLINGS, hash: 0.7 }).got;
const substituted = measure(hashNonce, 1, 0, { ...DEFAULT_COUPLINGS, hash: 0.8 }).got;
assert.notEqual(heavy.canonical, substituted.canonical);

const omega = initialOmega("mainnet");
assert.equal(omega.couplings.hash, 1);
omega.proposals.push({
  id: 1,
  title: "drop hash",
  proposer: "a".repeat(40),
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  couplingKey: "hash",
  couplingValue: 0,
});
const opened = openedCouplings(omega);
assert.equal(omega.couplings.hash, 1, "opening the next input must not rewrite Ω in place");
assert.equal(opened.hash, 0);
const governed = measure(hashNonce, 1, 0, opened).got;
assert.ok(
  Math.abs(base.canonical - governed.canonical - base.violations.hash ** 2) < 1e-12,
  "opened λ must move the residual by v_hash^2",
);

function row(name: string, nonce: number, work: number, pressure: number, lambda: Couplings, fee = 0) {
  const { txs, got } = measure(nonce, work, pressure, lambda, fee);
  return {
    name,
    timestamp: 1_700_000_000,
    nonce,
    difficulty: 1_000_000,
    work,
    pressure,
    fee,
    txs,
    lambda: [lambda.hash, lambda.structural, lambda.continuity, lambda.mempool, lambda.fees],
    canonical: String(got.canonical),
  };
}

const rows = [
  row("A-hash", hashNonce, 1, 0, { ...DEFAULT_COUPLINGS, hash: 0 }),
  row("B-structural", hashNonce, 1, 0, { ...DEFAULT_COUPLINGS, structural: 0 }),
  row("C-continuity", hashNonce, 0, 0, { ...DEFAULT_COUPLINGS, continuity: 0 }),
  row("D-mempool", hashNonce, 1, 0.5, { ...DEFAULT_COUPLINGS, mempool: 0 }),
  row("E-fees", hashNonce, 1, 0.5, { ...DEFAULT_COUPLINGS, fees: 0 }),
  row("zero", 6, 1, 0, { hash: 0, structural: 0, continuity: 0, mempool: 0, fees: 0 }),
  row("default", 6, 1, 0, DEFAULT_COUPLINGS),
  row("governance", hashNonce, 1, 0, opened),
  row("substituted-0.7", hashNonce, 1, 0, { ...DEFAULT_COUPLINGS, hash: 0.7 }),
];
const oracle = join(tmpdir(), "eq-lambda-oracle.json");
writeFileSync(oracle, JSON.stringify({ rows }));

const rust = execFileSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    join(repo, "equilibrium/Cargo.toml"),
    "--lib",
    "--",
    "--nocapture",
    "canonical_lambda_weights_are_the_dropped_violation",
    "canonical_residual_matches_the_site_lambda_oracle",
    "optimizer_lambda_is_not_canonical_admission",
    "a_partial_coupling_is_not_filled_with_ones",
  ],
  { encoding: "utf8", env: { ...process.env, EQ_LAMBDA_ORACLE: oracle } },
);
assert.match(rust, /lambda-oracle: rows 9/);
assert.match(rust, /canonical_residual_matches_the_site_lambda_oracle \.\.\. ok/);
assert.match(rust, /canonical_lambda_weights_are_the_dropped_violation \.\.\. ok/);
assert.match(rust, /optimizer_lambda_is_not_canonical_admission \.\.\. ok/);
assert.match(rust, /a_partial_coupling_is_not_filled_with_ones \.\.\. ok/);

console.log(JSON.stringify({
  ok: true,
  hashNonce,
  quiet: quiet.canonical,
  nonce6: loud.canonicalFp,
  openedHash: opened.hash,
  governanceDelta: base.canonical - governed.canonical,
  oracleRows: rows.length,
  level: "A for the λ-weighted canonical residual, including a coupling opened by a passed proposal. The successor that spends that λ is commit.run.ts. Not A for Android or the live host.",
}));
