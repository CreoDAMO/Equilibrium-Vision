/**
 * Authoritative delegate. `d:` stays the synthetic line and does not debit.
 * `a:D:V:X:PK:SIG` is the only delegate that can move funds.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorityPreimage, signAuthority } from "./authority";
import { applySuccessor, cloneOmega, initialOmega, omegaDigest, openedCouplings } from "./constitution";
import { canonicalEvidence } from "./evidence";
import { blankEvidence } from "./seal";
import type { StakeEvidence } from "./types";
import { keypairFromSeed } from "./wallet";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const born = initialOmega("mainnet");
const chainId = born.chainId;
const payer = keypairFromSeed("eq-delegate-authority-v1");
const other = keypairFromSeed("eq-delegate-authority-other");
const validator = [...born.validators.values()].find((v) => !v.jailed && !v.slashed && v.bondedStake > 0);
if (!validator) throw new Error("no validator");
assert.match(validator.address, /^[0-9a-f]{40}$/);
assert.match(payer.address, /^[0-9a-f]{40}$/);

const signed = signAuthority(payer, {
  op: "delegate",
  chainId,
  validator: validator.address,
  amount: 10,
});
assert.equal(
  authorityPreimage(payer.address, { op: "delegate", chainId, validator: validator.address, amount: 10 }),
  `eq-authority|v1|${chainId}|delegate|${payer.address}|${validator.address}|10||||`,
);

function line(op: { delegator: string; validator: string; amount: number; publicKey?: string; signature?: string }): string {
  const publicKey = op.publicKey ?? "";
  const signature = op.signature ?? "";
  if (publicKey !== "" || signature !== "") {
    return `a:${op.delegator}:${op.validator}:${op.amount}:${publicKey}:${signature}`;
  }
  return `d:${op.delegator}:${op.validator}:${op.amount}`;
}

function evidence(op: StakeEvidence) {
  return { ...blankEvidence(chainId), stake: [op] };
}

function fund() {
  const current = cloneOmega(born);
  current.ledger.set(payer.address, { balance: 1000, nonce: 0 });
  return current;
}

function step(current: ReturnType<typeof fund>, op: StakeEvidence) {
  const before = omegaDigest(current);
  const balance = current.ledger.get(payer.address)?.balance;
  const bonded = current.validators.get(validator!.address)?.bondedStake;
  const result = applySuccessor(current, {
    transactions: [],
    evidence: evidence(op),
    timestamp: 1_700_000_000,
    nonce: 6n,
    miner: validator!.address,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
    wasmAfter: null,
  });
  assert.equal(omegaDigest(current), before);
  assert.equal(current.ledger.get(payer.address)?.balance, balance);
  assert.equal(current.validators.get(validator!.address)?.bondedStake, bonded);
  return result;
}

const honestOp: StakeEvidence = {
  op: "delegate",
  delegator: payer.address,
  validator: validator.address,
  amount: 10,
  publicKey: signed.publicKey,
  signature: signed.signature,
};
const honestLine = line(honestOp);
assert.equal(canonicalEvidence(evidence(honestOp)).endsWith(`|||${honestLine}`), true);
assert.equal(honestLine.startsWith("a:"), true);
const honest = step(fund(), honestOp);
assert.equal(honest.ok, true);
if (!honest.ok) throw new Error(honest.error);
assert.equal(honest.next.ledger.get(payer.address)?.balance, 990);
assert.equal(honest.next.validators.get(validator.address)?.bondedStake, validator.bondedStake + 10);

const transplanted: StakeEvidence = { ...honestOp, amount: 11 };
const moved = step(fund(), transplanted);
assert.equal(moved.ok, false);
if (moved.ok) throw new Error("amount transplant debited");
assert.match(moved.error, /delegate authority refused/);

const flipped: StakeEvidence = {
  ...honestOp,
  signature: `${signed.signature.slice(0, -1)}${signed.signature.endsWith("a") ? "b" : "a"}`,
};
const badSig = step(fund(), flipped);
assert.equal(badSig.ok, false);
if (badSig.ok) throw new Error("bad signature debited");
assert.match(badSig.error, /delegate authority refused/);

const wrongKey: StakeEvidence = { ...honestOp, publicKey: other.publicKey };
const badKey = step(fund(), wrongKey);
assert.equal(badKey.ok, false);
if (badKey.ok) throw new Error("wrong key debited");
assert.match(badKey.error, /delegate authority refused/);

const syntheticOp: StakeEvidence = {
  op: "delegate",
  delegator: payer.address,
  validator: validator.address,
  amount: 10,
};
const syntheticLine = line(syntheticOp);
assert.equal(syntheticLine, `d:${payer.address}:${validator.address}:10`);
assert.equal(canonicalEvidence(evidence(syntheticOp)).endsWith(`|||${syntheticLine}`), true);
const synthetic = step(fund(), syntheticOp);
assert.equal(synthetic.ok, false);
if (synthetic.ok) throw new Error("bare delegate debited");
assert.match(synthetic.error, /delegate authority refused/);

function row(name: string, op: StakeEvidence & { op: "delegate" }, admits: boolean) {
  return {
    name,
    chainId,
    delegator: op.delegator,
    validator: op.validator,
    amount: op.amount,
    publicKey: op.publicKey ?? "",
    signature: op.signature ?? "",
    preimage: authorityPreimage(op.delegator, {
      op: "delegate",
      chainId,
      validator: op.validator,
      amount: op.amount,
    }),
    line: line(op),
    admits,
  };
}

const rows = [
  row("honest", honestOp, true),
  row("amount", transplanted, false),
  row("signature", flipped, false),
  row("key", wrongKey, false),
  row("synthetic", syntheticOp, false),
];
const oracle = join(tmpdir(), "eq-delegate-oracle.json");
writeFileSync(oracle, JSON.stringify({ rows }));
const rust = execFileSync(
  "cargo",
  ["test", "--manifest-path", join(repo, "equilibrium/Cargo.toml"), "--lib", "--", "--nocapture", "authoritative_delegate_matches_the_site_oracle"],
  { encoding: "utf8", env: { ...process.env, EQ_DELEGATE_ORACLE: oracle } },
);
assert.match(rust, /delegate-oracle: rows 5/);
assert.match(rust, /authoritative_delegate_matches_the_site_oracle \.\.\. ok/);

console.log(JSON.stringify({
  ok: true,
  chainId,
  rows: rows.length,
  honest: honestLine.slice(0, 2),
  synthetic: syntheticLine.slice(0, 2),
  refused: "delegate authority refused",
}));
