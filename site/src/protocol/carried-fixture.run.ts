/**
 * Byte record of the carried second block.
 * The statement id is not a substitute for these bytes.
 *   WRITE_FIXTURE=1 npx tsx src/protocol/carried-fixture.run.ts
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { initialOmega, openedCouplings, successor, omegaDigest } from "./constitution";
import { evaluateResidual } from "./solver";
import { merkleRoot, sha256Hex } from "./crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { minerKey } from "./genesis";
import { blankEvidence, sealFromSuccessor } from "./seal";
import { evaluateCtp1, encodeEvidence, structuredInputId } from "./ctp1";
import { canonicalEvidence } from "./evidence";
import { encodeOmega, fullStateId } from "./fullstate";
import { paramsOf } from "./constitution";
import { bytesToHex } from "./bytes";
import { encodeContext, encodeInputs, encodeProjectedInputs, executionInputId, predecessorBytes, statementBytes, statementId } from "./transition-proof";
import { residualPreimage } from "./reward-binding";

const FIXTURE = new URL("../../../docs/fixtures/carried-second.json", import.meta.url);

function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

function artifact(name: string, bytes: Uint8Array) {
  return { name, byteLength: bytes.length, sha256: sha256Hex(bytes), hex: hex(bytes) };
}

function inputs(before: ReturnType<typeof initialOmega>, timestamp: number) {
  return {
    transactions: [] as [],
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

const full = { ...carriedIn, wasmAfter: null as null };
const params = paramsOf(sealed.carried.chainId);
if (!params) throw new Error("no params");
const preimage = residualPreimage(sealed.carried, carriedIn);
const digest = sha256(preimage);
const root = merkleRoot(["0".repeat(64)]);
const opened = openedCouplings(sealed.carried);
const breakdown = evaluateResidual(
  {
    prevHash: sealed.carried.tipHash,
    merkleRoot: root,
    timestamp: carriedIn.timestamp,
    nonce: carriedIn.nonce,
    difficulty: carriedIn.difficulty,
  },
  [],
  { cumulativeWork: Math.max(0, sealed.carried.height + 1), mempoolPressure: 0 },
  opened,
);

const absent = blankEvidence(1);
const emptyLists = { ...absent, cognition: [], settle: [], withdraw: [] };
const absentStructured = encodeEvidence(absent);
const emptyStructured = encodeEvidence(emptyLists);

const record = {
  checkpoint: "fbcc0d0",
  statementBinding: "the statement is transitionStatement(executeTransition(...))",
  network: "mainnet",
  sequence: "genesis → first successor → sealed carried state → second successor",
  firstHeader: sealed.hash,
  predecessorTip: sealed.carried.tipHash,
  predecessorFs1: fullStateId(sealed.carried),
  predecessorOmegaDigest: omegaDigest(sealed.carried),
  predecessorIsNotOmegaDigest: fullStateId(sealed.carried) !== omegaDigest(sealed.carried),
  statement: carried.statement,
  statementId: carried.statementId,
  statementIdIsHash: statementId(carried.statement) === carried.statementId,
  structuredInputId: structuredInputId(full),
  structuredInputIdInStatement: false,
  contextCommits: "numeric model, network parameters, and ARBITRAGE_CODE. That is the SHA-256 of the wasm bytecode, not the bytecode.",
  production: {
    height: carried.stepped.next.height,
    residual: String(carried.stepped.residual),
    residualFp: String(carried.stepped.residualFp),
    reward: carried.stepped.reward,
    liquid: carried.stepped.liquid,
    difficulty: carried.stepped.next.difficulty,
    successor: carried.statement.successor,
    carried: carried.statement.carried,
    header: carried.statement.header,
  },
  residualAgreesWithDirectEvaluation: breakdown.canonical === carried.stepped.residual,
  directResidual: {
    canonical: String(breakdown.canonical),
    hFrac: String(breakdown.hFrac),
    hashVal: breakdown.hashVal,
    canonicalFp: String(breakdown.canonicalFp),
  },
  evidenceIdentity: {
    note: "statement inputId is the projected transaction fields plus structured evidence. status, blockHash, and blockHeight are not in it. The canonical evidence string still collapses absent and empty lists. That string is not the statement input.",
    canonicalEqual: canonicalEvidence(absent) === canonicalEvidence(emptyLists),
    structuredEqual: sha256Hex(absentStructured) === sha256Hex(emptyStructured),
    absentStructured: artifact("evidence-absent", absentStructured),
    emptyStructured: artifact("evidence-empty-lists", emptyStructured),
  },
  artifacts: {
    predecessor: artifact("fs1-predecessor", predecessorBytes(sealed.carried)),
    structuredEvidence: artifact("structured-evidence", encodeEvidence(full.evidence)),
    inputs: artifact("encode-inputs", encodeInputs(full)),
    projected: artifact("projected-inputs", encodeProjectedInputs(full)),
    context: artifact("encode-context", encodeContext(params)),
    statement: artifact("statement-bytes", statementBytes(carried.statement)),
    residualPreimage: artifact("residual-preimage", preimage),
    residualDigest: artifact("residual-digest", digest),
    omega: artifact("fs1-omega", encodeOmega(sealed.carried)),
  },
};

assert.equal(record.artifacts.predecessor.sha256, record.predecessorFs1);
assert.equal(record.artifacts.statement.sha256, record.statementId);
assert.equal(executionInputId(full), carried.statement.inputId);
assert.notEqual(record.artifacts.inputs.sha256, carried.statement.inputId);
assert.equal(record.artifacts.context.sha256, carried.statement.contextId);
assert.equal(record.artifacts.omega.sha256, record.artifacts.predecessor.sha256);
assert.equal(record.evidenceIdentity.canonicalEqual, true);
assert.equal(record.evidenceIdentity.structuredEqual, false);
assert.equal(record.residualAgreesWithDirectEvaluation, true);
assert.equal(record.production.reward, 2);
assert.equal(record.production.liquid, 0);

if (process.env.WRITE_FIXTURE === "1") {
  writeFileSync(FIXTURE, `${JSON.stringify(record, null, 2)}\n`);
  console.log("wrote carried fixture", record.statementId);
} else {
  const saved = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(saved, record);
  console.log("carried fixture matches the version-1 statement");
  console.log(record.statementId);
}
