/**
 * C-007 public statement. Version 1.
 *
 * This is the statement a complete transition proof has to open.
 * It is not that proof. verifyTransitionProof rejects every proof,
 * including an empty one. installNext, absorb, and proveCandidate
 * do not call it. C-007 stays open.
 *
 * Public, all of it. There is no witness yet.
 *   predecessor  FS1 of Ω before the transition. Not omegaDigest.
 *   inputs       the projected transaction fields, the structured evidence,
 *                and the block claims. Not the canonical evidence string.
 *                status, blockHash, and blockHeight are not part of it.
 *   stateRootStateId  FS1 of the clone at the stateRoot line.
 *   context      the network parameters, the wasm program id, and the host ABI manifest.
 *   successor    FS1 of the Ω the relation returned, tipHash still previous.
 *   carried      FS1 of the Ω the next block reads, tipHash = H.
 *   adopted      the header commitments sealFromSuccessor already publishes.
 *
 * transitionRoot still commits omegaDigest, because that is what the header
 * does today. The predecessor field does not.
 */
import { canonicalPressure, sha256Hex } from "./crypto";
import { NUMERIC_MODEL, paramsOf, type CanonicalInputs, type Omega, type Successor } from "./constitution";
import { encodeEvidence } from "./ctp1";
import { ARBITRAGE_CODE, canonicalEvidence } from "./evidence";
import { encodeOmega, fullStateId } from "./fullstate";
import { hostAbiManifest } from "./host-abi";
import { V1_RELATION_ID } from "./v1-relation";
import type { SealedSuccessor } from "./seal";
import type { NetworkParams, TxRecord } from "./types";

export const TRANSITION_PROOF_VERSION = 1;

/**
 * Live adoption does not consult this. Setting it true while
 * verifyTransitionProof still rejects would stop the chain.
 */
export const ADOPTION_REQUIRES_TRANSITION_PROOF = false;

const text = new TextEncoder();

export type TransitionStatement = {
  version: 1;
  numericModel: typeof NUMERIC_MODEL;
  /** Names the v1 claim. A stronger property is not this field. */
  v1: typeof V1_RELATION_ID;
  predecessor: string;
  inputId: string;
  contextId: string;
  stateRoot: string;
  stateRootStateId: string;
  omegaRoot: string;
  successor: string;
  carried: string;
  evidenceRoot: string;
  transitionRoot: string;
  header: string;
  residualFp: string;
  wasm: string;
};

export type TransitionProof = {
  system: string;
  bytes: Uint8Array;
};

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; reason: "no complete transition proof is defined" };

class Buf {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.parts.push(b);
  }
  u8(n: number) {
    this.parts.push(Uint8Array.of(n & 0xff));
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
  }
  str(s: string) {
    const raw = text.encode(s);
    this.u32(raw.length);
    this.bytes(raw);
  }
  f64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.parts.push(b);
  }
  finish(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function txBytes(tx: TxRecord): Uint8Array {
  const b = new Buf();
  b.str(tx.hash);
  b.str(tx.from);
  b.str(tx.to);
  b.f64(tx.amount);
  b.f64(tx.fee);
  b.f64(tx.nonce);
  b.f64(tx.timestamp);
  b.str(tx.status);
  b.str(tx.signature);
  b.str(tx.publicKey);
  b.str(tx.blockHash ?? "");
  b.u8(tx.blockHash === null ? 1 : 0);
  b.f64(tx.blockHeight ?? 0);
  b.u8(tx.blockHeight === null ? 1 : 0);
  return b.finish();
}

/** The canonical evidence string. Not injective. Not the statement input. */
export function encodeInputs(inputs: CanonicalInputs): Uint8Array {
  const b = new Buf();
  b.u32(inputs.transactions.length);
  for (const tx of inputs.transactions) b.bytes(txBytes(tx));
  b.str(inputs.evidence ? canonicalEvidence(inputs.evidence) : "");
  b.f64(inputs.timestamp);
  if (typeof inputs.nonce !== "bigint" || inputs.nonce < 0n || inputs.nonce > 0xffffffffffffffffn) {
    throw new Error("nonce is not a u64");
  }
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, inputs.nonce, true);
  b.bytes(nonce);
  b.str(inputs.miner);
  b.f64(canonicalPressure(inputs.committedPressure));
  b.f64(inputs.difficulty);
  const c = inputs.couplings;
  b.f64(c.hash);
  b.f64(c.structural);
  b.f64(c.continuity);
  b.f64(c.mempool);
  b.f64(c.fees);
  return b.finish();
}

/** Transactions without the fields sealing stamps on afterwards. Timestamp stays. It is not signed. */
export function encodeProjectedInputs(inputs: Omit<CanonicalInputs, "wasmAfter">): Uint8Array {
  const b = new Buf();
  b.u32(inputs.transactions.length);
  for (const tx of inputs.transactions) {
    b.str(tx.hash);
    b.str(tx.from);
    b.str(tx.to);
    b.f64(tx.amount);
    b.f64(tx.fee);
    b.f64(tx.nonce);
    b.f64(tx.timestamp);
    b.str(tx.signature);
    b.str(tx.publicKey);
  }
  b.f64(inputs.timestamp);
  if (typeof inputs.nonce !== "bigint" || inputs.nonce < 0n || inputs.nonce > 0xffffffffffffffffn) {
    throw new Error("nonce is not a u64");
  }
  const nonce = new Uint8Array(8);
  new DataView(nonce.buffer).setBigUint64(0, inputs.nonce, true);
  b.bytes(nonce);
  b.str(inputs.miner);
  b.f64(canonicalPressure(inputs.committedPressure));
  b.f64(inputs.difficulty);
  const c = inputs.couplings;
  b.f64(c.hash);
  b.f64(c.structural);
  b.f64(c.continuity);
  b.f64(c.mempool);
  b.f64(c.fees);
  return b.finish();
}

/** Projected inputs plus structured evidence. Absent is not empty. */
export function executionInputId(inputs: Omit<CanonicalInputs, "wasmAfter">): string {
  const rest = encodeProjectedInputs(inputs);
  const evidence = encodeEvidence(inputs.evidence);
  const body = new Uint8Array(rest.length + evidence.length);
  body.set(rest, 0);
  body.set(evidence, rest.length);
  return sha256Hex(body);
}

/** Parameters that change the transition, plus the wasm program this process executes. */
export function encodeContext(params: NetworkParams): Uint8Array {
  const b = new Buf();
  b.str(NUMERIC_MODEL);
  b.str(params.id);
  b.f64(params.chainId);
  b.f64(params.targetBlockTimeMs);
  b.f64(params.residualThreshold);
  b.f64(params.territoryThreshold);
  b.f64(params.initialDifficulty);
  b.f64(params.baseReward);
  b.f64(params.halvingInterval);
  b.f64(params.maxTxPerBlock);
  b.f64(params.finalityQuorum);
  b.f64(params.finalityLag);
  b.f64(params.unbondingPeriod);
  b.f64(params.withdrawalTimeout);
  b.u8(params.allowFaucet ? 1 : 0);
  b.f64(params.faucetAmount);
  b.str(ARBITRAGE_CODE);
  b.str(hostAbiManifest());
  return b.finish();
}

/** The statement is this execution. It does not accept a separate successor. */
export function transitionStatement(execution: {
  predecessor: string;
  inputId: string;
  contextId: string;
  stateRoot: string;
  stateRootStateId: string;
  omegaRoot: string;
  successor: string;
  carried: string;
  evidenceRoot: string;
  transitionRoot: string;
  header: string;
  before: Omega;
  inputs: Omit<CanonicalInputs, "wasmAfter">;
  stepped: Extract<Successor, { ok: true }>;
  sealed: SealedSuccessor;
}): TransitionStatement {
  if (fullStateId(execution.before) !== execution.predecessor) throw new Error("predecessor is not this execution");
  const params = paramsOf(execution.before.chainId);
  if (!params) throw new Error("no network parameters for this chain");
  if (executionInputId(execution.inputs) !== execution.inputId) throw new Error("input is not this execution");
  if (sha256Hex(encodeContext(params)) !== execution.contextId) throw new Error("context is not this execution");
  if (fullStateId(execution.stepped.next) !== execution.successor) throw new Error("successor is not this execution");
  if (fullStateId(execution.sealed.digestOmega) !== execution.successor) throw new Error("seal is not this successor");
  if (fullStateId(execution.sealed.carried) !== execution.carried) throw new Error("carried is not this execution");
  if (execution.sealed.hash !== execution.header) throw new Error("header is not this execution");
  if (execution.stepped.stateRoot !== execution.stateRoot) throw new Error("state root is not this execution");
  if (execution.stepped.stateRootStateId !== execution.stateRootStateId) {
    throw new Error("state root identity is not this execution");
  }
  if (execution.stepped.omegaRoot !== execution.omegaRoot) throw new Error("omega root is not this execution");
  if (execution.sealed.evidenceRoot !== execution.evidenceRoot) throw new Error("evidence root is not this execution");
  if (execution.sealed.transitionRoot !== execution.transitionRoot) throw new Error("transition root is not this execution");
  return {
    version: 1,
    numericModel: NUMERIC_MODEL,
    v1: V1_RELATION_ID,
    predecessor: execution.predecessor,
    inputId: execution.inputId,
    contextId: execution.contextId,
    stateRoot: execution.stateRoot,
    stateRootStateId: execution.stateRootStateId,
    omegaRoot: execution.omegaRoot,
    successor: execution.successor,
    carried: execution.carried,
    evidenceRoot: execution.evidenceRoot,
    transitionRoot: execution.transitionRoot,
    header: execution.header,
    residualFp: String(execution.stepped.residualFp),
    wasm: ARBITRAGE_CODE,
  };
}

/** The block's statement names this execution and this header. Replay produced the execution. This is not a proof. */
export function statementAgrees(
  statement: TransitionStatement,
  execution: {
    predecessor: string;
    inputId: string;
    contextId: string;
    stateRoot: string;
    stateRootStateId: string;
    omegaRoot: string;
    successor: string;
    carried: string;
    evidenceRoot: string;
    transitionRoot: string;
    header: string;
    residualFp: number;
  },
  header: string,
): string | null {
  if (statement.version !== TRANSITION_PROOF_VERSION) return "statement version is not this relation";
  if (statement.v1 !== V1_RELATION_ID) return "relation is not v1";
  if (statement.numericModel !== NUMERIC_MODEL) return "numeric model is not this relation";
  if (statement.wasm !== ARBITRAGE_CODE) return "wasm is not this program";
  if (statement.residualFp !== String(execution.residualFp)) return "residual bits are not this transition";
  if (statement.predecessor !== execution.predecessor) return "predecessor is not installed";
  if (statement.header !== header || statement.header !== execution.header) return "statement is not this header";
  if (statement.inputId !== execution.inputId) return "statement is not this input";
  if (statement.contextId !== execution.contextId) return "statement is not this context";
  if (statement.stateRoot !== execution.stateRoot) return "statement is not this state root";
  if (statement.stateRootStateId !== execution.stateRootStateId) return "statement is not this checkpoint";
  if (statement.omegaRoot !== execution.omegaRoot) return "statement is not this omega root";
  if (statement.successor !== execution.successor) return "statement is not this successor";
  if (statement.carried !== execution.carried) return "statement is not this carried state";
  if (statement.evidenceRoot !== execution.evidenceRoot) return "statement is not this evidence";
  if (statement.transitionRoot !== execution.transitionRoot) return "statement is not this transition";
  return null;
}

/** Predecessor is FS1. transitionRoot still commits omegaDigest. Those bytes are not the same field. */
export function statementBytes(statement: TransitionStatement): Uint8Array {
  const b = new Buf();
  b.bytes(text.encode("EQTP"));
  b.u8(statement.version);
  b.str(statement.v1);
  b.str(statement.numericModel);
  b.str(statement.predecessor);
  b.str(statement.inputId);
  b.str(statement.contextId);
  b.str(statement.stateRoot);
  b.str(statement.stateRootStateId);
  b.str(statement.omegaRoot);
  b.str(statement.successor);
  b.str(statement.carried);
  b.str(statement.evidenceRoot);
  b.str(statement.transitionRoot);
  b.str(statement.header);
  b.str(statement.residualFp);
  b.str(statement.wasm);
  return b.finish();
}

export function statementId(statement: TransitionStatement): string {
  return sha256Hex(statementBytes(statement));
}

/** No proof system is defined. Every call fails closed. */
export function verifyTransitionProof(
  _statement: TransitionStatement,
  _proof: TransitionProof | null,
): TransitionVerdict {
  return { ok: false, reason: "no complete transition proof is defined" };
}

/** FS1 bytes, so a caller can show a digest collision without leaving the module. */
export function predecessorBytes(omega: Omega): Uint8Array {
  return encodeOmega(omega);
}
