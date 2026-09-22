import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes";

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return bytesToHex(sha256(bytes));
}

/** Territory (TypeScript stack) double-SHA256 over UTF-8 hex strings. */
export function hash256String(data: string): string {
  return sha256Hex(utf8(sha256Hex(utf8(data))));
}

/** Canonical header / tx hashing over raw bytes. */
export function hash256Bytes(data: Uint8Array): string {
  return bytesToHex(sha256(sha256(data)));
}

export interface HeaderCommitment {
  prevHash: string;
  merkleRoot: string;
  stateRoot: string;
  timestamp: number;
  nonce: number;
  difficulty: number;
  residualFp: number;
  miner: string;
  height: number;
  committedPressure: number;
}

/**
 * Canonical header hash. Binds merkle, state root, nonce, residual fingerprint,
 * and the mempool pressure that entered the solver — so a light body can
 * recompute without trusting the miner's claimed residual.
 */
export function canonicalHeaderHash(parts: HeaderCommitment): string {
  return hash256Bytes(
    concatBytes(
      utf8(
        [
          parts.prevHash,
          parts.merkleRoot,
          parts.stateRoot,
          String(parts.timestamp),
          String(parts.nonce),
          String(parts.difficulty),
          String(parts.residualFp),
          parts.miner,
          String(parts.height),
          parts.committedPressure.toFixed(6),
        ].join("|"),
      ),
    ),
  );
}

export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return "0".repeat(64);
  if (hashes.length === 1) return hashes[0]!;
  let level = [...hashes];
  while (level.length > 1) {
    if (level.length % 2 !== 0) level.push(level[level.length - 1]!);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hash256String(level[i]! + level[i + 1]!));
    }
    level = next;
  }
  return level[0]!;
}

export function merkleProof(hashes: string[], index: number): string[] {
  if (hashes.length === 0) return [];
  const proof: string[] = [];
  let level = [...hashes];
  let idx = index;
  while (level.length > 1) {
    if (level.length % 2 !== 0) level.push(level[level.length - 1]!);
    const sibling = idx % 2 === 0 ? level[idx + 1]! : level[idx - 1]!;
    proof.push(sibling);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hash256String(level[i]! + level[i + 1]!));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyMerkleProof(leaf: string, proof: string[], index: number, root: string): boolean {
  let hash = leaf;
  let idx = index;
  for (const sib of proof) {
    hash = idx % 2 === 0 ? hash256String(hash + sib) : hash256String(sib + hash);
    idx = Math.floor(idx / 2);
  }
  return hash === root;
}

export function addressFromPubkeyHex(pubKeyHex: string): string {
  const raw = hexToBytes(pubKeyHex);
  if (raw.length !== 32) throw new Error("public key must be 32 bytes");
  return sha256Hex(raw).slice(0, 40);
}

export const PHI = (1 + Math.sqrt(5)) / 2;
export const RESIDUAL_SCALE = 1e18;

export function residualToFixed(residual: number): number {
  if (!Number.isFinite(residual)) return Number.MAX_SAFE_INTEGER;
  return Math.floor(residual * RESIDUAL_SCALE);
}

export function u64LeFromHash(digest: Uint8Array): bigint {
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return view.getBigUint64(0, true);
}

export { concatBytes, hexToBytes, bytesToHex, sha256 };
