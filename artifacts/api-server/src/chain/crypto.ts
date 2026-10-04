import { createHash } from "crypto";

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hash256(data: string): string {
  return sha256(sha256(data));
}

export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return "0".repeat(64);
  if (hashes.length === 1) return hashes[0];
  let level = [...hashes];
  while (level.length > 1) {
    if (level.length % 2 !== 0) level.push(level[level.length - 1]);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(hash256(level[i] + level[i + 1]));
    }
    level = next;
  }
  return level[0];
}

export function addressFromSeed(seed: string): string {
  return sha256(seed).slice(0, 40);
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
  chainId?: number;
  evidenceRoot?: string;
  omegaRoot?: string;
  /** Digest of (Ω, I). Omitted on the frozen thirteen-field preimage. */
  transitionRoot?: string;
}

/**
 * Same preimage as `canonicalHeaderHash` in the public kernel.
 * Double SHA-256 over the raw digest, not over the hex text.
 * Nonce, state root, and residual fingerprint are inside it.
 */
export function canonicalHeaderHash(parts: HeaderCommitment): string {
  const fields = [
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
  ];
  if (parts.chainId !== undefined && parts.evidenceRoot !== undefined) {
    fields.push(String(parts.chainId), parts.evidenceRoot, parts.omegaRoot ?? "");
    if (parts.transitionRoot !== undefined) fields.push(parts.transitionRoot);
  }
  const first = createHash("sha256").update(Buffer.from(fields.join("|"), "utf8")).digest();
  return createHash("sha256").update(first).digest("hex");
}
