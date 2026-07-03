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

export function randomHex(bytes: number): string {
  return createHash("sha256")
    .update(Math.random().toString() + Date.now().toString())
    .digest("hex")
    .slice(0, bytes * 2);
}

export function addressFromSeed(seed: string): string {
  return sha256(seed).slice(0, 40);
}
