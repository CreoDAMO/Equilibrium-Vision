/**
 * One execution of the production relation.
 * composeBlock, commit, and absorb all call this.
 * A refusal is the result. It is not a reason to try a different input.
 */
import { sha256Hex } from "./crypto";
import { paramsOf, runSuccessor, type CanonicalInputs, type Omega, type Successor } from "./constitution";
import { encodeEvidence } from "./ctp1";
import { fullStateId } from "./fullstate";
import { sealFromSuccessor, type SealedSuccessor } from "./seal";
import { encodeContext, encodeInputs } from "./transition-proof";

export type ExecutedTransition = {
  predecessor: string;
  inputId: string;
  contextId: string;
  successor: string;
  carried: string;
  stateRoot: string;
  omegaRoot: string;
  header: string;
  evidenceRoot: string;
  transitionRoot: string;
  stepped: Extract<Successor, { ok: true }>;
  sealed: SealedSuccessor;
};

/** Evidence bytes are the structured encoding. Absent is not empty. */
export function executionInputId(inputs: Omit<CanonicalInputs, "wasmAfter">): string {
  const rest = encodeInputs({ ...inputs, evidence: undefined, wasmAfter: null });
  const evidence = encodeEvidence(inputs.evidence);
  const body = new Uint8Array(rest.length + evidence.length);
  body.set(rest, 0);
  body.set(evidence, rest.length);
  return sha256Hex(body);
}

export function executeTransition(
  before: Omega,
  inputs: Omit<CanonicalInputs, "wasmAfter">,
): { ok: true; execution: ExecutedTransition } | { ok: false; error: string; predecessor: string; inputId: string } {
  const predecessor = fullStateId(before);
  const inputId = executionInputId(inputs);
  const stepped = runSuccessor(before, inputs);
  if (!stepped.ok) return { ok: false, error: stepped.error, predecessor, inputId };
  const params = paramsOf(before.chainId);
  if (!params) return { ok: false, error: "unknown chain", predecessor, inputId };
  const sealed = sealFromSuccessor(before, { ...inputs, wasmAfter: null }, stepped);
  return {
    ok: true,
    execution: {
      predecessor,
      inputId,
      contextId: sha256Hex(encodeContext(params)),
      successor: fullStateId(stepped.next),
      carried: fullStateId(sealed.carried),
      stateRoot: stepped.stateRoot,
      omegaRoot: stepped.omegaRoot,
      header: sealed.hash,
      evidenceRoot: sealed.evidenceRoot,
      transitionRoot: sealed.transitionRoot,
      stepped,
      sealed,
    },
  };
}
