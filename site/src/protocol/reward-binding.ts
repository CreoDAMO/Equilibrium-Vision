/**
 * The reward header is not a free string.
 * It is the preimage `applySuccessor` hashes: the predecessor tip,
 * the ordered-transaction merkle root, the input timestamp, and the nonce.
 * The sealed header hash is a different field. C-007 stays open.
 */
import { merkleRoot, sha256Hex } from "./crypto";
import { omegaDigest, paramsOf, type CanonicalInputs, type Omega } from "./constitution";
import { concatBytes, hex32, u64ToLe } from "./bytes";
import { fullStateId } from "./fullstate";
import {
  encodeContext,
  executionInputId,
  statementId,
  type TransitionStatement,
} from "./transition-proof";

export function residualPreimage(
  before: Omega,
  inputs: Pick<CanonicalInputs, "transactions" | "timestamp" | "nonce">,
): Uint8Array {
  const hashes = inputs.transactions.map((tx) => tx.hash);
  const root = merkleRoot(hashes.length ? hashes : ["0".repeat(64)]);
  const parts = [
    hex32(before.tipHash),
    hex32(root),
    u64ToLe(inputs.timestamp),
    u64ToLe(inputs.nonce),
  ];
  for (const hash of hashes) parts.push(hex32(hash));
  return concatBytes(...parts);
}

export function rewardHeaderBinds(before: Omega, inputs: CanonicalInputs, claimed: Uint8Array): boolean {
  const derived = residualPreimage(before, inputs);
  if (claimed.length !== derived.length) return false;
  for (let i = 0; i < claimed.length; i++) {
    if (claimed[i] !== derived[i]) return false;
  }
  return true;
}

/** The statement id is the hash of the statement bytes. A supplied label is not an id. */
export function statementIdBinds(statement: TransitionStatement, claimedId: string): boolean {
  return claimedId === statementId(statement);
}

/** Predecessor is FS1. The omega digest is not accepted in its place. */
export function predecessorBinds(before: Omega, statement: TransitionStatement): boolean {
  const fs1 = fullStateId(before);
  return statement.predecessor === fs1 && fs1 !== omegaDigest(before);
}

export function inputIdBinds(inputs: CanonicalInputs, statement: TransitionStatement): boolean {
  return statement.inputId === executionInputId(inputs);
}

export function contextIdBinds(before: Omega, statement: TransitionStatement): boolean {
  const params = paramsOf(before.chainId);
  if (!params) return false;
  return statement.contextId === sha256Hex(encodeContext(params));
}
