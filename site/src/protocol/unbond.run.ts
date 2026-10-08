/**
 * Canonical unbond. Only `u:D:V:X:PK:SIG` releases a delegation.
 * Lots are consumed in array order. matureAt is the pre-state height plus the period.
 * The successor pays that position once, and stateRoot does not contain it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainState } from "../../../artifacts/api-server/src/chain/state";
import { authorityPreimage, signAuthority, verifyDelegateEvidence, verifyUnbondEvidence } from "./authority";
import { applySuccessor, cloneOmega, initialOmega, omegaDigest, openedCouplings, stateRootOf, type Omega, type Successor } from "./constitution";
import { canonicalEvidence } from "./evidence";
import { NETWORKS } from "./networks";
import { blankEvidence } from "./seal";
import { DEFAULT_COUPLINGS, type StakeEvidence, type Unbonding } from "./types";
import { keypairFromSeed } from "./wallet";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const born = initialOmega("mainnet");
const chainId = born.chainId;
const payer = keypairFromSeed("eq-unbond-lifecycle-v1");
const other = keypairFromSeed("eq-unbond-lifecycle-other");
const live = [...born.validators.values()].filter((v) => !v.jailed && !v.slashed && v.bondedStake > 0);
const minerV = live[0];
const otherV = live[1];
if (!minerV || !otherV) throw new Error("need two validators");
const validator = minerV.address;
const missing = "ab".repeat(20);
assert.equal(born.validators.has(missing), false);
assert.equal(NETWORKS.mainnet.unbondingPeriod, 10);
assert.equal(NETWORKS.testnet.unbondingPeriod, 10);

const alias = cloneOmega(born);
alias.unbonding.push({ delegator: payer.address, validator, amount: 1, matureAt: 1 });
assert.equal(born.unbonding.length, 0);

function prove(op: "delegate" | "unbond", target: string, amount: number, chain = chainId, who = payer) {
  return signAuthority(who, { op, chainId: chain, validator: target, amount });
}

function evidence(stake: StakeEvidence[]) {
  return { ...blankEvidence(chainId), stake };
}

function step(current: Omega, stake: StakeEvidence[] = []) {
  const before = omegaDigest(current);
  const result = applySuccessor(current, {
    transactions: [],
    evidence: evidence(stake),
    timestamp: Math.max(current.tipTimestamp + 1, 1_700_000_000),
    nonce: 6n,
    miner: validator,
    committedPressure: 0,
    couplings: openedCouplings(current),
    difficulty: current.difficulty,
  });
  assert.equal(omegaDigest(current), before);
  return result;
}

function must(result: Successor): Extract<Successor, { ok: true }> {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error);
  return result;
}

function unbondOp(target: string, amount: number, proof: { publicKey: string; signature: string }): StakeEvidence {
  return {
    op: "unbond",
    delegator: payer.address,
    validator: target,
    amount,
    publicKey: proof.publicKey,
    signature: proof.signature,
  };
}

const bareDelegate: StakeEvidence = { op: "delegate", delegator: payer.address, validator, amount: 10 };
assert.equal(canonicalEvidence(evidence([bareDelegate])).endsWith(`|||d:${payer.address}:${validator}:10`), true);

const bonded0 = minerV.bondedStake;
const delegate40 = prove("delegate", validator, 40);
const delegate60 = prove("delegate", validator, 60);
const funded = cloneOmega(born);
funded.ledger.set(payer.address, { balance: 1000, nonce: 0 });
const delegated = must(step(funded, [
  { op: "delegate", delegator: payer.address, validator, amount: 40, publicKey: delegate40.publicKey, signature: delegate40.signature },
  { op: "delegate", delegator: payer.address, validator, amount: 60, publicKey: delegate60.publicKey, signature: delegate60.signature },
]));
assert.equal(delegated.next.height, 0);
assert.equal(delegated.next.ledger.get(payer.address)?.balance, 900);
assert.deepEqual(delegated.next.delegations.map((d) => d.amount), [40, 60]);
assert.equal(delegated.next.validators.get(validator)?.bondedStake, bonded0 + 100);
assert.equal(delegated.next.unbonding.length, 0);

const unbond70 = prove("unbond", validator, 70);
const delegateAsUnbond = prove("delegate", validator, 70);
assert.notEqual(
  authorityPreimage(payer.address, { op: "unbond", chainId, validator, amount: 70 }),
  authorityPreimage(payer.address, { op: "delegate", chainId, validator, amount: 70 }),
);
assert.equal(
  verifyUnbondEvidence(chainId, {
    delegator: payer.address,
    validator,
    amount: 70,
    publicKey: delegateAsUnbond.publicKey,
    signature: delegateAsUnbond.signature,
  }),
  "unbond authority refused",
);
assert.equal(
  verifyDelegateEvidence(chainId, {
    delegator: payer.address,
    validator,
    amount: 70,
    publicKey: unbond70.publicKey,
    signature: unbond70.signature,
  }),
  "delegate authority refused",
);

const released = must(step(delegated.next, [unbondOp(validator, 70, unbond70)]));
assert.equal(canonicalEvidence(evidence([unbondOp(validator, 70, unbond70)])).endsWith(
  `|||u:${payer.address}:${validator}:70:${unbond70.publicKey}:${unbond70.signature}`,
), true);
assert.equal(released.next.height, 1);
assert.equal(released.next.ledger.get(payer.address)?.balance, 900);
assert.deepEqual(released.next.delegations.map((d) => d.amount), [30]);
assert.equal(released.next.validators.get(validator)?.bondedStake, bonded0 + 30);
assert.equal(released.next.unbonding.length, 1);
assert.equal(released.next.unbonding[0]?.amount, 70);
assert.equal(released.next.unbonding[0]?.matureAt, 10);
assert.equal(released.next.unbonding[0]?.delegator, payer.address);

let cursor = released.next;
let paidAt = -1;
let balanceAtPay = 0;
for (let i = 0; i < 20 && cursor.height < 12; i++) {
  const beforeBal = cursor.ledger.get(payer.address)?.balance ?? 0;
  const stepped = must(step(cursor));
  const next = stepped.next;
  const bal = next.ledger.get(payer.address)?.balance ?? 0;
  if (next.height < 10) {
    assert.equal(bal, beforeBal);
    assert.equal(next.unbonding.length, 1);
    assert.equal(next.unbonding[0]?.matureAt, 10);
  } else if (next.height === 10) {
    assert.equal(bal, beforeBal + 70);
    assert.equal(next.unbonding.length, 0);
    assert.deepEqual(next.delegations.map((d) => d.amount), [30]);
    paidAt = next.height;
    balanceAtPay = bal;
  } else {
    assert.equal(bal, balanceAtPay);
    assert.equal(next.unbonding.length, 0);
  }
  cursor = next;
}
assert.equal(paidAt, 10);
assert.equal(balanceAtPay, 970);
assert.equal(born.unbonding.length, 0);
assert.equal(born.delegations.length, 0);

interface Lot {
  delegator: string;
  validator: string;
  amount: number;
}

function row(spec: {
  name: string;
  target: string;
  host?: string;
  amount: number;
  jailed?: boolean;
  lots: Lot[];
  publicKey: string;
  signature: string;
  verified: boolean;
  error: string | null;
  kept: Lot[];
}) {
  const height = 0;
  const host = spec.host ?? spec.target;
  const line = `u:${payer.address}:${spec.target}:${spec.amount}:${spec.publicKey}:${spec.signature}`;
  return {
    name: spec.name,
    chainId,
    height,
    delegator: payer.address,
    validator: spec.target,
    hostValidator: host,
    amount: spec.amount,
    publicKey: spec.publicKey,
    signature: spec.signature,
    preimage: authorityPreimage(payer.address, { op: "unbond", chainId, validator: spec.target, amount: spec.amount }),
    line,
    bonded: 1_500_000,
    balance: 1000,
    jailed: Boolean(spec.jailed),
    lots: spec.lots,
    verified: spec.verified,
    error: spec.error,
    kept: spec.kept,
    matureAt: height + NETWORKS.mainnet.unbondingPeriod,
  };
}

function lot(who: string, target: string, amount: number): Lot {
  return { delegator: who, validator: target, amount };
}

const spanLots = [lot(payer.address, validator, 40), lot(payer.address, validator, 60)];
const foreignLots = [lot(payer.address, validator, 40), lot(other.address, validator, 5), lot(payer.address, validator, 60)];
const flippedSig = `${unbond70.signature.slice(0, -1)}${unbond70.signature.endsWith("a") ? "b" : "a"}`;
const wrongChain = prove("unbond", validator, 70, chainId + 1);
const rows = [
  row({
    name: "span",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: unbond70.publicKey,
    signature: unbond70.signature,
    verified: true,
    error: null,
    kept: [lot(payer.address, validator, 30)],
  }),
  row({
    name: "partial",
    target: validator,
    amount: 10,
    lots: spanLots,
    publicKey: prove("unbond", validator, 10).publicKey,
    signature: prove("unbond", validator, 10).signature,
    verified: true,
    error: null,
    kept: [lot(payer.address, validator, 30), lot(payer.address, validator, 60)],
  }),
  row({
    name: "exact",
    target: validator,
    amount: 100,
    lots: spanLots,
    publicKey: prove("unbond", validator, 100).publicKey,
    signature: prove("unbond", validator, 100).signature,
    verified: true,
    error: null,
    kept: [],
  }),
  row({
    name: "first",
    target: validator,
    amount: 40,
    lots: spanLots,
    publicKey: prove("unbond", validator, 40).publicKey,
    signature: prove("unbond", validator, 40).signature,
    verified: true,
    error: null,
    kept: [lot(payer.address, validator, 60)],
  }),
  row({
    name: "foreign",
    target: validator,
    amount: 70,
    lots: foreignLots,
    publicKey: unbond70.publicKey,
    signature: unbond70.signature,
    verified: true,
    error: null,
    kept: [lot(other.address, validator, 5), lot(payer.address, validator, 30)],
  }),
  row({
    name: "over",
    target: validator,
    amount: 101,
    lots: spanLots,
    publicKey: prove("unbond", validator, 101).publicKey,
    signature: prove("unbond", validator, 101).signature,
    verified: true,
    error: "unbond funds refused",
    kept: [],
  }),
  row({
    name: "missing",
    target: validator,
    amount: 10,
    lots: [],
    publicKey: prove("unbond", validator, 10).publicKey,
    signature: prove("unbond", validator, 10).signature,
    verified: true,
    error: "unbond funds refused",
    kept: [],
  }),
  row({
    name: "signature",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: unbond70.publicKey,
    signature: flippedSig,
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "key",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: other.publicKey,
    signature: unbond70.signature,
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "amount",
    target: validator,
    amount: 71,
    lots: spanLots,
    publicKey: unbond70.publicKey,
    signature: unbond70.signature,
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "delegate-sig",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: delegateAsUnbond.publicKey,
    signature: delegateAsUnbond.signature,
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "chain",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: wrongChain.publicKey,
    signature: wrongChain.signature,
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "unsigned",
    target: validator,
    amount: 70,
    lots: spanLots,
    publicKey: "",
    signature: "",
    verified: false,
    error: "unbond authority refused",
    kept: [],
  }),
  row({
    name: "jailed",
    target: otherV.address,
    host: otherV.address,
    amount: 40,
    jailed: true,
    lots: [lot(payer.address, otherV.address, 40)],
    publicKey: prove("unbond", otherV.address, 40).publicKey,
    signature: prove("unbond", otherV.address, 40).signature,
    verified: true,
    error: "unbond refused",
    kept: [],
  }),
  row({
    name: "unknown",
    target: missing,
    host: validator,
    amount: 40,
    lots: [lot(payer.address, validator, 40)],
    publicKey: prove("unbond", missing, 40).publicKey,
    signature: prove("unbond", missing, 40).signature,
    verified: true,
    error: "unbond refused",
    kept: [],
  }),
];

for (const item of rows) {
  const current = cloneOmega(born);
  current.height = item.height;
  current.ledger.set(payer.address, { balance: item.balance, nonce: 0 });
  const host = current.validators.get(item.hostValidator);
  if (!host) throw new Error(`${item.name} host`);
  host.bondedStake = item.bonded;
  host.jailed = item.jailed;
  current.delegations = item.lots.map((entry) => ({ ...entry }));
  const op = unbondOp(item.validator, item.amount, { publicKey: item.publicKey, signature: item.signature });
  assert.equal(canonicalEvidence(evidence([op])).endsWith(`|||${item.line}`), true, item.name);
  const beforeLots = current.delegations.map((entry) => ({ ...entry }));
  const result = step(current, [op]);
  if (item.error) {
    assert.equal(result.ok, false, item.name);
    if (result.ok) throw new Error(item.name);
    assert.equal(result.error, item.error, item.name);
    assert.deepEqual(current.delegations, beforeLots, item.name);
    assert.equal(current.unbonding.length, 0, item.name);
    assert.equal(current.validators.get(item.hostValidator)?.bondedStake, item.bonded, item.name);
    assert.equal(current.ledger.get(payer.address)?.balance, item.balance, item.name);
  } else {
    const stepped = must(result);
    const next = stepped.next;
    assert.deepEqual(next.delegations, item.kept, item.name);
    assert.equal(next.unbonding.length, 1, item.name);
    assert.equal(next.unbonding[0]?.amount, item.amount, item.name);
    assert.equal(next.unbonding[0]?.matureAt, item.matureAt, item.name);
    assert.ok(next.delegations.every((entry) => entry.amount > 0), item.name);
    assert.equal(next.validators.get(item.hostValidator)?.bondedStake, item.bonded - item.amount, item.name);
    assert.equal(next.ledger.get(payer.address)?.balance, item.balance, item.name);
  }
}

function digestOmega(unbonding: Unbonding[]): Omega {
  return {
    chainId: 1,
    height: 3,
    tipHash: "0".repeat(64),
    tipTimestamp: 0,
    difficulty: 1_000_000,
    finalizedHeight: -1,
    couplings: { ...DEFAULT_COUPLINGS },
    ledger: new Map([[payer.address, { balance: 1000, nonce: 0 }]]),
    pools: [],
    btc: [],
    ethPubkey: "",
    ethCommittee: "",
    eth: [],
    wasm: new Map(),
    validators: new Map([[
      validator,
      {
        address: validator,
        moniker: "v",
        bondedStake: 100,
        accumulatedRewards: 0,
        slashed: false,
        jailed: false,
        uptime: 1,
        blocksProposed: 0,
        commission: 0,
      },
    ]]),
    delegations: [],
    unbonding,
    proposals: [],
    models: [],
    settlements: [],
  };
}

const position = (amount: number, matureAt: number): Unbonding => ({
  delegator: payer.address,
  validator,
  amount,
  matureAt,
});
const digests = [
  { name: "empty", unbonding: [] as Unbonding[] },
  { name: "pending", unbonding: [position(70, 10)] },
  { name: "amount", unbonding: [position(71, 10)] },
  { name: "mature", unbonding: [position(70, 11)] },
  { name: "order-ab", unbonding: [position(70, 10), position(30, 12)] },
  { name: "order-ba", unbonding: [position(30, 12), position(70, 10)] },
].map((item) => {
  const omega = digestOmega(item.unbonding);
  return {
    name: item.name,
    chainId: 1,
    height: 3,
    delegator: payer.address,
    validator,
    balance: 1000,
    bonded: 100,
    difficulty: 1_000_000,
    unbonding: item.unbonding,
    digest: omegaDigest(omega),
    stateRoot: stateRootOf(omega),
  };
});
const emptyDigest = digests[0]!;
const pendingDigest = digests[1]!;
assert.notEqual(emptyDigest.digest, pendingDigest.digest);
assert.notEqual(pendingDigest.digest, digests[2]?.digest);
assert.notEqual(pendingDigest.digest, digests[3]?.digest);
assert.notEqual(digests[4]?.digest, digests[5]?.digest);
assert.ok(digests.every((item) => item.stateRoot === emptyDigest.stateRoot));

const savedPeriod = NETWORKS.mainnet.unbondingPeriod;
NETWORKS.mainnet.unbondingPeriod = 99;
try {
  const fresh = cloneOmega(born);
  fresh.height = 0;
  fresh.ledger.set(payer.address, { balance: 1000, nonce: 0 });
  fresh.delegations = [lot(payer.address, validator, 40)];
  const created = must(step(fresh, [unbondOp(validator, 10, prove("unbond", validator, 10))]));
  assert.equal(created.next.unbonding[0]?.matureAt, 99);
  const prior = cloneOmega(born);
  prior.height = 0;
  prior.ledger.set(payer.address, { balance: 50, nonce: 0 });
  prior.unbonding = [position(10, 10)];
  const held = must(step(prior));
  assert.equal(held.next.height, 1);
  assert.equal(held.next.unbonding[0]?.matureAt, 10);
  assert.equal(held.next.ledger.get(payer.address)?.balance, 50);
} finally {
  NETWORKS.mainnet.unbondingPeriod = savedPeriod;
}

const operational = new ChainState();
const queued = "cd".repeat(20);
operational.unbondingQueue.push({
  delegator: queued,
  validator,
  amount: 70,
  unbondingHeight: 0,
  completionHeight: 1,
});
operational.processUnbonding(100);
assert.equal(operational.ledger.balance(queued), 0);
assert.equal(operational.unbondingQueue.length, 1);
assert.equal(operational.unbondingQueue[0]?.amount, 70);

const settle = {
  delegator: payer.address,
  validator,
  amount: 70,
  matureAt: 10,
  startBalance: 100,
  holdHeight: 9,
  payHeight: 10,
};
const oracle = join(tmpdir(), "eq-unbond-oracle.json");
writeFileSync(oracle, JSON.stringify({ rows, digests, settle }));
const rust = execFileSync(
  "cargo",
  ["test", "--manifest-path", join(repo, "equilibrium/Cargo.toml"), "--lib", "--", "--nocapture", "unbond_lifecycle_tests"],
  { encoding: "utf8", env: { ...process.env, EQ_UNBOND_ORACLE: oracle } },
);
assert.match(rust, /unbond_consumes_lots_in_order_and_settles_once \.\.\. ok/);
assert.match(rust, /unbond-oracle: rows 15/);
assert.match(rust, /authoritative_unbond_matches_the_site_oracle \.\.\. ok/);

console.log(JSON.stringify({
  ok: true,
  rows: rows.length,
  paidAt,
  balanceAtPay,
  matureAt: 10,
  period: NETWORKS.mainnet.unbondingPeriod,
  queuePaid: false,
}));
