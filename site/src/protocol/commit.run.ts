/**
 * λ → residual → reward → Ω′ → omegaRoot → transitionRoot → header.
 * Site applies the successor. Rust applies the same genesis transition
 * from the pre-state and I, and does not read Ω′.
 * Transactions, stake evidence, and wasm execution are not this file.
 * Android is not this file.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applySuccessor,
  cloneOmega,
  initialOmega,
  omegaDigest,
  openedCouplings,
  transitionDigest,
  type CanonicalInputs,
  type Omega,
} from "./constitution";
import { canonicalEvidence } from "./evidence";
import { minerKey } from "./genesis";
import { blankEvidence, sealFromSuccessor } from "./seal";
import type { TxRecord } from "./types";

const repo = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const omega = initialOmega("mainnet");
const born = omegaDigest(omega);
const miner = minerKey("mainnet").address;

function inputs(current: Omega, couplings = openedCouplings(current)): CanonicalInputs {
  return {
    transactions: [],
    evidence: blankEvidence(current.chainId),
    timestamp: 1_700_000_000,
    nonce: 6,
    miner,
    committedPressure: 0,
    couplings,
    difficulty: current.difficulty,
    wasmAfter: null,
  };
}

function snap(current: Omega) {
  return {
    tipHash: current.tipHash,
    chainId: current.chainId,
    height: current.height,
    tipTimestamp: current.tipTimestamp,
    difficulty: current.difficulty,
    finalizedHeight: current.finalizedHeight,
    couplings: current.couplings,
    ledger: [...current.ledger.entries()].map(([address, acc]) => ({
      address,
      balance: acc.balance,
      nonce: acc.nonce,
    })),
    pools: current.pools.map((p) => ({
      id: p.id,
      address: p.address,
      reserveA: p.reserveA,
      reserveB: p.reserveB,
      txCount: p.txCount,
      fee: p.fee,
    })),
    btc: current.btc.map((h) => ({
      height: h.height,
      hash: h.hash,
      prevHash: h.prevHash,
      merkleRoot: h.merkleRoot,
      bits: h.bits,
    })),
    ethPubkey: current.ethPubkey,
    eth: current.eth.map((h) => ({
      slot: h.slot,
      hash: h.hash,
      participants: h.participants,
      parentRoot: h.parentRoot,
      stateRoot: h.stateRoot,
      bodyRoot: h.bodyRoot,
    })),
    wasm: [...current.wasm.entries()],
    validators: [...current.validators.values()].map((v) => ({ ...v })),
    delegations: current.delegations.map((d) => ({ ...d })),
    proposals: current.proposals.map((p) => ({
      id: p.id,
      status: p.status,
      title: p.title,
      proposer: p.proposer,
      deposit: p.deposit,
      yes: p.yes,
      no: p.no,
      abstain: p.abstain,
      couplingKey: p.couplingKey ?? null,
      couplingValue: p.couplingValue ?? null,
      ballots: p.ballots ?? [],
    })),
    models: current.models.map((m) => ({ ...m })),
    settlements: current.settlements.map((s) => ({ ...s })),
  };
}

function transitionOf(current: Omega, spec: CanonicalInputs) {
  return {
    txs: spec.transactions.map((t) => ({
      hash: t.hash,
      from: t.from,
      to: t.to,
      amount: t.amount,
      fee: t.fee,
      nonce: t.nonce,
    })),
    evidence: spec.evidence ? canonicalEvidence(spec.evidence) : "",
    timestamp: spec.timestamp,
    nonce: spec.nonce,
    miner: spec.miner,
    pressure: spec.committedPressure,
    difficulty: spec.difficulty,
    couplings: spec.couplings,
  };
}

const loudIn = inputs(omega);
const loud = applySuccessor(omega, loudIn);
assert.equal(loud.ok, true);
if (!loud.ok) throw new Error("continuity on");
assert.equal(omegaDigest(omega), born);

const quietOmega = cloneOmega(omega);
quietOmega.proposals.push({
  id: 1,
  title: "drop continuity",
  proposer: "a".repeat(40),
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  ballots: [],
  couplingKey: "continuity",
  couplingValue: 0,
});
assert.equal(quietOmega.couplings.continuity, 1);
const quietBefore = omegaDigest(quietOmega);
const quietIn = inputs(quietOmega);
const quiet = applySuccessor(quietOmega, quietIn);
assert.equal(quiet.ok, true);
if (!quiet.ok) throw new Error(quiet.error);
assert.equal(omegaDigest(quietOmega), quietBefore);
assert.equal(quiet.next.couplings.continuity, 0);
assert.equal(quiet.next.proposals[0]!.status, "executed");

assert.ok(Math.abs(loud.residual - quiet.residual - 1) < 1e-12);
assert.equal(quiet.residualFp, 201_100_202_523_998);
assert.equal(loud.reward, 0);
assert.equal(quiet.reward, 100);
assert.equal(quiet.liquid, 10);
assert.equal(loud.next.ledger.get(miner)!.balance, 1_500_000);
assert.equal(quiet.next.ledger.get(miner)!.balance, 1_500_010);
assert.notEqual(loud.omegaRoot, quiet.omegaRoot);
assert.notEqual(transitionDigest(omega, loudIn), transitionDigest(quietOmega, quietIn));

const loudSeal = sealFromSuccessor(omega, loudIn, loud);
const quietSeal = sealFromSuccessor(quietOmega, quietIn, quiet);
assert.equal(loudSeal.transitionRoot, transitionDigest(omega, loudIn));
assert.equal(quietSeal.transitionRoot, transitionDigest(quietOmega, quietIn));
assert.notEqual(loudSeal.hash, quietSeal.hash);

const forged = applySuccessor(omega, inputs(omega, { ...openedCouplings(omega), continuity: 0 }));
assert.equal(forged.ok, false);
if (forged.ok) throw new Error("forged coupling installed");
assert.match(forged.error, /opened couplings/);
assert.equal(omegaDigest(omega), born);

const substituted = cloneOmega(omega);
substituted.proposals.push({
  id: 2,
  title: "hash weight",
  proposer: "a".repeat(40),
  deposit: 0,
  yes: 1,
  no: 0,
  abstain: 0,
  status: "passed",
  ballots: [],
  couplingKey: "hash",
  couplingValue: 0.7,
});
const openedHash = openedCouplings(substituted);
assert.equal(openedHash.hash, 0.7);
assert.equal(substituted.couplings.hash, 1);
const wrong = applySuccessor(substituted, inputs(substituted, { ...openedHash, hash: 0.8 }));
assert.equal(wrong.ok, false);
if (wrong.ok) throw new Error("0.8 replaced 0.7");
const right = applySuccessor(substituted, inputs(substituted));
assert.equal(right.ok, true);
if (!right.ok) throw new Error(right.error);
assert.equal(right.next.couplings.hash, 0.7);
assert.notEqual(right.omegaRoot, loud.omegaRoot);

const rich = cloneOmega(omega);
rich.btc.push({
  height: 0,
  hash: "ab".repeat(32),
  prevHash: "00".repeat(32),
  merkleRoot: "11".repeat(32),
  bits: 486604799,
});
rich.ethPubkey = "aa".repeat(48);
rich.eth.push({
  slot: 1,
  hash: "cd".repeat(32),
  participants: 342,
  parentRoot: "22".repeat(32),
  stateRoot: "33".repeat(32),
  bodyRoot: "44".repeat(32),
});
rich.wasm.set("paused", "0");
rich.delegations.push({ delegator: "dd".repeat(20), validator: miner, amount: 10 });
rich.models.push({
  id: 1,
  uri: "ipfs://model",
  residualFp: 5,
  supportHash: "ee".repeat(32),
  status: "bound",
  proposedAt: 3,
});
rich.settlements.push({
  id: 2,
  asset: "btc",
  foreignRef: "ref",
  from: "ff".repeat(20),
  to: miner,
  amount: 7,
  status: "locked",
});
rich.proposals.push({
  id: 9,
  title: "a b",
  proposer: miner,
  deposit: 1,
  yes: 2,
  no: 0,
  abstain: 0,
  status: "open",
  ballots: [{ voter: miner, option: "yes" }],
  couplingKey: "fees",
  couplingValue: 0.5,
});
const richTx: TxRecord = {
  hash: "12".repeat(32),
  from: miner,
  to: "34".repeat(20),
  amount: 5,
  fee: 1,
  nonce: 0,
  timestamp: 1_700_000_000,
  status: "pending",
  signature: "00",
  publicKey: "00",
  blockHash: null,
  blockHeight: null,
};
const richIn = inputs(rich);
richIn.transactions = [richTx];
const richRoot = omegaDigest(rich);
const richTransition = transitionDigest(rich, richIn);

function row(name: string, pre: Omega, post: Omega, spec: CanonicalInputs, omegaRoot: string, transitionRoot: string) {
  return {
    name,
    omegaRoot,
    transitionRoot,
    pre: snap(pre),
    post: snap(post),
    transition: transitionOf(pre, spec),
  };
}

const rows = [
  row("continuity-on", omega, loud.next, loudIn, loud.omegaRoot, loudSeal.transitionRoot),
  row("continuity-off", quietOmega, quiet.next, quietIn, quiet.omegaRoot, quietSeal.transitionRoot),
  row("fields", rich, rich, richIn, richRoot, richTransition),
];
const oracle = join(tmpdir(), "eq-commit-oracle.json");
writeFileSync(oracle, JSON.stringify({ rows }));

const wrongIn = inputs(substituted, { ...openedHash, hash: 0.8 });
function successorCase(
  name: string,
  pre: Omega,
  spec: CanonicalInputs,
  site: {
    omegaRoot: string;
    transitionRoot: string;
    header: string;
    stateRoot: string;
    residual: number;
    residualFp: number;
    reward: number;
    liquid: number;
    minerBalance: number;
    continuity: number;
    proposalStatus: string | null;
  } | null,
  refuse?: string,
) {
  return {
    name,
    pre: snap(pre),
    transition: transitionOf(pre, spec),
    site: site && {
      omegaRoot: site.omegaRoot,
      transitionRoot: site.transitionRoot,
      header: site.header,
      stateRoot: site.stateRoot,
      residual: String(site.residual),
      residualFp: String(site.residualFp),
      reward: site.reward,
      liquid: site.liquid,
      minerBalance: site.minerBalance,
      continuity: site.continuity,
      proposalStatus: site.proposalStatus,
    },
    refuse: refuse ?? null,
  };
}
const cases = [
  successorCase("continuity-on", omega, loudIn, {
    omegaRoot: loud.omegaRoot,
    transitionRoot: loudSeal.transitionRoot,
    header: loudSeal.hash,
    stateRoot: loud.stateRoot,
    residual: loud.residual,
    residualFp: loud.residualFp,
    reward: loud.reward,
    liquid: loud.liquid,
    minerBalance: loud.next.ledger.get(miner)!.balance,
    continuity: loud.next.couplings.continuity,
    proposalStatus: null,
  }),
  successorCase("continuity-off", quietOmega, quietIn, {
    omegaRoot: quiet.omegaRoot,
    transitionRoot: quietSeal.transitionRoot,
    header: quietSeal.hash,
    stateRoot: quiet.stateRoot,
    residual: quiet.residual,
    residualFp: quiet.residualFp,
    reward: quiet.reward,
    liquid: quiet.liquid,
    minerBalance: quiet.next.ledger.get(miner)!.balance,
    continuity: quiet.next.couplings.continuity,
    proposalStatus: quiet.next.proposals[0]!.status,
  }),
  successorCase("substituted", substituted, wrongIn, null, "couplings are not the opened couplings"),
];
const successorOracle = join(tmpdir(), "eq-successor-oracle.json");
writeFileSync(successorOracle, JSON.stringify({ cases }));

const rust = execFileSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    join(repo, "equilibrium/Cargo.toml"),
    "--lib",
    "--",
    "--nocapture",
    "commitment_matches_the_site_oracle",
    "js_number_and_uri_match_the_digest_alphabet",
    "native_successor_applies_the_continuity_transition",
  ],
  { encoding: "utf8", env: { ...process.env, EQ_COMMIT_ORACLE: oracle, EQ_SUCCESSOR_ORACLE: successorOracle } },
);
assert.match(rust, /commit-oracle: rows 3/);
assert.match(rust, /commitment_matches_the_site_oracle \.\.\. ok/);
assert.match(rust, /js_number_and_uri_match_the_digest_alphabet \.\.\. ok/);
assert.match(rust, /native-successor: rows 3/);
assert.match(rust, /native-successor: substituted refused/);
assert.match(rust, /native-successor: continuity-off reward 100/);
assert.match(rust, /native_successor_applies_the_continuity_transition \.\.\. ok/);

console.log(JSON.stringify({
  ok: true,
  loudReward: loud.reward,
  quietReward: quiet.reward,
  quietFp: quiet.residualFp,
  liquid: quiet.liquid,
  omegaMoved: loud.omegaRoot !== quiet.omegaRoot,
  transitionMoved: loudSeal.transitionRoot !== quietSeal.transitionRoot,
  headerMoved: loudSeal.hash !== quietSeal.hash,
  substituted: "refused",
  oracleRows: rows.length,
  level: "A for the native continuity successor. The enumerated mainnet surface is membrane.run.ts. Not Android. Not every byte string.",
}));
