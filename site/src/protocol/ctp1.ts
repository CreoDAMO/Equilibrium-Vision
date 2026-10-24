/**
 * CTP-1 checker.
 *
 * It runs the production successor once and compares the public statement
 * with that result. It does not implement a second transition, and it does
 * not build a succinct proof. verifyTransitionProof still rejects every
 * proof. ADOPTION_REQUIRES_TRANSITION_PROOF stays false. The integer
 * projection of one real statement is proved in `equilibrium/src/ctp1_circuit.rs`.
 * That Groth16 check does not run the successor, and it does not prove
 * the residual, the header, or the wasm host. C-007 stays open.
 */
import { sha256Hex } from "./crypto";
import {
  successor,
  type CanonicalInputs,
  type Omega,
  type Successor,
} from "./constitution";
import { sealFromSuccessor } from "./seal";
import {
  ADOPTION_REQUIRES_TRANSITION_PROOF,
  statementId,
  transitionStatement,
  type TransitionStatement,
} from "./transition-proof";
import type {
  CognitionEvidence,
  EthEvidence,
  SettlementEvidence,
  StakeEvidence,
  TransitionEvidence,
  WithdrawalEvidence,
} from "./types";

export const CTP1_SYSTEM = "reexecution-v1";

const text = new TextEncoder();

class Buf {
  private parts: Uint8Array[] = [];
  u8(n: number) {
    this.parts.push(Uint8Array.of(n & 0xff));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    this.parts.push(b);
  }
  str(s: string) {
    const raw = text.encode(s);
    this.u32(raw.length);
    this.parts.push(raw);
  }
  opt(s: string | undefined) {
    if (s === undefined) this.u8(0);
    else {
      this.u8(1);
      this.str(s);
    }
  }
  f64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.parts.push(b);
  }
  list<T>(items: readonly T[] | undefined, one: (item: T) => void) {
    if (items === undefined) {
      this.u8(0);
      return;
    }
    this.u8(1);
    this.u32(items.length);
    for (const item of items) one(item);
  }
  finish(): Uint8Array {
    const n = this.parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function stake(b: Buf, item: StakeEvidence) {
  if (item.op === "delegate") {
    b.u8(1);
    b.str(item.delegator);
    b.str(item.validator);
    b.f64(item.amount);
    b.opt(item.publicKey);
    b.opt(item.signature);
    return;
  }
  if (item.op === "unbond") {
    b.u8(2);
    b.str(item.delegator);
    b.str(item.validator);
    b.f64(item.amount);
    b.opt(item.publicKey);
    b.opt(item.signature);
    return;
  }
  if (item.op === "claim") {
    b.u8(3);
    b.str(item.address);
    return;
  }
  if (item.op === "slash") {
    b.u8(4);
    b.str(item.validator);
    b.str(item.reason);
    return;
  }
  if (item.op === "vote") {
    b.u8(5);
    b.str(item.voter);
    b.f64(item.id);
    b.str(item.option);
    return;
  }
  b.u8(6);
  b.f64(item.id);
  b.str(item.proposer);
  b.f64(item.deposit);
  b.str(item.title);
  b.opt(item.couplingKey);
  if (item.couplingValue === undefined) b.u8(0);
  else {
    b.u8(1);
    b.f64(item.couplingValue);
  }
}

function eth(b: Buf, item: EthEvidence) {
  if (item.op === "bootstrap") {
    b.u8(1);
    b.str(item.committee);
    b.str(item.aggregate);
    return;
  }
  if (item.op === "rotate") {
    b.u8(2);
    b.str(item.committee);
    b.str(item.aggregate);
    b.str(item.participation);
    b.str(item.signature);
    return;
  }
  b.u8(3);
  b.f64(item.slot);
  b.f64(item.proposerIndex);
  b.str(item.parentRoot);
  b.str(item.stateRoot);
  b.str(item.bodyRoot);
  b.str(item.participation);
  b.str(item.signature);
}

function cognition(b: Buf, item: CognitionEvidence) {
  if (item.kind === "bind") {
    b.u8(1);
    b.f64(item.residualFp);
    b.str(item.proof);
    return;
  }
  if (item.kind === "challenge") {
    b.u8(2);
    b.f64(item.id);
    b.str(item.supportHash);
    b.str(item.proof);
    return;
  }
  b.u8(3);
  b.f64(item.id);
  b.str(item.uri);
  b.f64(item.residualFp);
  b.str(item.supportHash);
  b.str(item.proof);
}

function settlement(b: Buf, item: SettlementEvidence) {
  if (item.op === "lock") {
    b.u8(1);
    b.f64(item.id);
    b.str(item.asset);
    b.str(item.foreignRef);
    b.str(item.from);
    b.str(item.to);
    b.f64(item.amount);
    return;
  }
  b.u8(2);
  b.f64(item.id);
}

function withdrawal(b: Buf, item: WithdrawalEvidence) {
  if (item.op === "open") {
    b.u8(1);
    b.str(item.sender);
    b.f64(item.amount);
    b.str(item.network);
    b.str(item.asset);
    b.str(item.destination);
    b.f64(item.nonce);
    b.opt(item.publicKey);
    b.opt(item.signature);
    return;
  }
  if (item.op === "exec") {
    b.u8(2);
    b.str(item.headerRlp);
    return;
  }
  if (item.op === "settleEth") {
    b.u8(3);
    b.str(item.id);
    b.str(item.blockHash);
    b.f64(item.txIndex);
    b.str(item.receiptRlp);
    b.u32(item.receiptProof.length);
    for (const row of item.receiptProof) b.str(row);
    b.f64(item.logIndex);
    b.str(item.txRlp);
    b.u32(item.txProof.length);
    for (const row of item.txProof) b.str(row);
    return;
  }
  b.u8(4);
  b.str(item.id);
  b.str(item.headerHash);
  b.f64(item.vout);
  b.str(item.rawTx);
  b.u32(item.merkle.length);
  for (const row of item.merkle) b.str(row);
}

/** Length-prefixed evidence. Absent is not empty. The canonical string is not this. */
export function encodeEvidence(ev: TransitionEvidence | undefined): Uint8Array {
  const b = new Buf();
  if (!ev) {
    b.u8(0);
    return b.finish();
  }
  b.u8(1);
  b.u8(ev.v);
  b.f64(ev.chainId);
  b.str(ev.wasmCode);
  b.list(ev.btc, (item) => {
    b.f64(item.height);
    b.str(item.headerHex);
  });
  b.list(ev.eth, (item) => eth(b, item));
  b.list(ev.wasm, (item) => {
    b.str(item.method);
    b.str(item.caller);
  });
  b.list(ev.stake, (item) => stake(b, item));
  b.list(ev.cognition, (item) => cognition(b, item));
  b.list(ev.settle, (item) => settlement(b, item));
  b.list(ev.withdraw, (item) => withdrawal(b, item));
  return b.finish();
}

export function structuredInputId(inputs: CanonicalInputs): string {
  return sha256Hex(encodeEvidence(inputs.evidence));
}

export type Ctp1Witness = {
  before: Omega;
  inputs: Omit<CanonicalInputs, "wasmAfter">;
};

export type Ctp1Evaluation = {
  ok: true;
  statement: TransitionStatement;
  statementId: string;
  structuredInputId: string;
  stepped: Extract<Successor, { ok: true }>;
};

export type Ctp1Failure = { ok: false; reason: string };

/** One production execution. The caller does not supply the successor. */
export async function evaluateCtp1(witness: Ctp1Witness): Promise<Ctp1Evaluation | Ctp1Failure> {
  const stepped = await successor(witness.before, witness.inputs);
  if (!stepped.ok) return { ok: false, reason: stepped.error };
  const full: CanonicalInputs = { ...witness.inputs, wasmAfter: null };
  const sealed = sealFromSuccessor(witness.before, full, stepped);
  const statement = transitionStatement(witness.before, full, stepped, sealed);
  return {
    ok: true,
    statement,
    statementId: statementId(statement),
    structuredInputId: structuredInputId(full),
    stepped,
  };
}

export type Ctp1Proof = {
  system: typeof CTP1_SYSTEM;
  statementId: string;
  structuredInputId: string;
};

export async function proveCtp1(witness: Ctp1Witness): Promise<{ ok: true; proof: Ctp1Proof; evaluation: Ctp1Evaluation } | Ctp1Failure> {
  const evaluation = await evaluateCtp1(witness);
  if (!evaluation.ok) return evaluation;
  return {
    ok: true,
    evaluation,
    proof: {
      system: CTP1_SYSTEM,
      statementId: evaluation.statementId,
      structuredInputId: evaluation.structuredInputId,
    },
  };
}

function sameStatement(left: TransitionStatement, right: TransitionStatement): boolean {
  return statementId(left) === statementId(right);
}

/**
 * Re-executes the production successor. A matching claim is a passing check.
 * It is not a proof that the verifier avoided that execution.
 */
export async function verifyCtp1(proof: Ctp1Proof | null, witness: Ctp1Witness | null): Promise<Ctp1Evaluation | Ctp1Failure> {
  if (!proof || proof.system !== CTP1_SYSTEM) return { ok: false, reason: "not a reexecution claim" };
  if (!witness) return { ok: false, reason: "reexecution has no witness; this is not a succinct proof" };
  const again = await evaluateCtp1(witness);
  if (!again.ok) return again;
  if (again.statementId !== proof.statementId) return { ok: false, reason: "statement is not this execution" };
  if (again.structuredInputId !== proof.structuredInputId) return { ok: false, reason: "evidence identity is not this execution" };
  return again;
}

export function c007Status(): { closed: false; reason: string } {
  return {
    closed: false,
    reason: ADOPTION_REQUIRES_TRANSITION_PROOF
      ? "the adoption flag is set, but the checker still only re-executes"
      : "verifyTransitionProof rejects every proof, and adoption does not require one",
  };
}

/** Live adoption passes requireProof false. The true branch is what a mandatory check would refuse. */
export async function adoptionGate(
  requireProof: boolean,
  witness: Ctp1Witness | null,
  proof: Ctp1Proof | null,
): Promise<{ ok: true; enforced: boolean } | Ctp1Failure> {
  if (!requireProof) return { ok: true, enforced: false };
  const verdict = await verifyCtp1(proof, witness);
  if (!verdict.ok) return verdict;
  return { ok: true, enforced: true };
}

export function statementsMatch(left: TransitionStatement, right: TransitionStatement): boolean {
  return sameStatement(left, right);
}
