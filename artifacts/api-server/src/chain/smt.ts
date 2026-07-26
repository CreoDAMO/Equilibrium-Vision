/**
 * smt.ts — Sparse Merkle Tree (256-bit key space)
 *
 * This is the cryptographic foundation for mobile light nodes. Every block
 * header now carries a `stateRoot` — a single 32-byte commitment to the
 * entire world state (accounts, UTXOs, contract storage). A phone can verify
 * any account balance or UTXO with a 256-sibling Merkle proof instead of
 * downloading the full chain.
 *
 * Design:
 *   - 256-level binary tree (keys are SHA-256 hashes → 256-bit path)
 *   - Domain-separated hashing: leaf = SHA256(0x00 ‖ key ‖ value),
 *     internal = SHA256(0x01 ‖ left ‖ right)
 *   - Empty subtree hashes precomputed so absent leaves cost O(1)
 *   - Node-cache memoises subtree roots across sibling lookups
 *   - Proofs are 256 sibling hashes (one per level); verifiable offline
 */

import { createHash } from "crypto";

// ── Domain separation ─────────────────────────────────────────────────────────

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Hash a leaf node: SHA256(0x00 ‖ key32 ‖ value32). */
function hashLeaf(key: Buffer, value: Buffer): string {
  return sha256(Buffer.concat([LEAF_PREFIX, key, value]));
}

/** Hash an internal node: SHA256(0x01 ‖ left32 ‖ right32). */
function hashInternal(left: Buffer, right: Buffer): string {
  return sha256(Buffer.concat([NODE_PREFIX, left, right]));
}

// ── Empty subtree hashes ──────────────────────────────────────────────────────
//
// EMPTY_HASHES[0] = hash of an empty leaf slot
// EMPTY_HASHES[i] = hash of an empty subtree of height i
// EMPTY_HASHES[256] = root of an entirely empty tree

function precomputeEmptyHashes(): readonly string[] {
  const h: string[] = new Array(257);
  h[0] = sha256(Buffer.concat([LEAF_PREFIX, Buffer.alloc(64)]));
  for (let i = 1; i <= 256; i++) {
    const prev = Buffer.from(h[i - 1]!, "hex");
    h[i] = sha256(Buffer.concat([NODE_PREFIX, prev, prev]));
  }
  return h;
}

export const EMPTY_HASHES: readonly string[] = precomputeEmptyHashes();

// ── Bit extraction ────────────────────────────────────────────────────────────

/** Get bit `i` of a 32-byte key buffer (MSB first, i=0 is the highest bit). */
function getBit(key: Buffer, i: number): 0 | 1 {
  const byteIdx = Math.floor(i / 8);
  const bitIdx = 7 - (i % 8);
  return (((key[byteIdx] ?? 0) >> bitIdx) & 1) as 0 | 1;
}

// ── Proof shape ───────────────────────────────────────────────────────────────

export interface SMTProof {
  /** 64-char hex key */
  key: string;
  /** 64-char hex value, or null for a non-membership proof */
  value: string | null;
  /**
   * 256 sibling hashes, siblings[0] is the sibling at depth 0
   * (one level below the root), siblings[255] is the sibling at depth 255
   * (one level above the leaf).
   */
  siblings: string[];
  /** Root at the moment the proof was generated. */
  root: string;
}

/**
 * Compact SMT proof — only non-default siblings are transmitted.
 *
 * A standard 256-sibling proof is 256 × 32 bytes = 8 KB per proof. For a
 * sparse tree (typical at testnet/early-mainnet scale), most siblings are
 * the precomputed EMPTY_HASHES and carry no information. This compact form
 * drops them, reducing proof size to O(log n × 32 bytes) — typically
 * 32–512 bytes for a tree with fewer than 2^20 leaves.
 *
 * Mobile-critical: verifying your account balance should not cost 8 KB
 * of bandwidth per block. A phone syncing 1 000 accounts/day saves ~7.5 MB.
 *
 * Verification: expand sparse siblings back to the full 256-length array
 * (fill gaps with EMPTY_HASHES[255-depth]) then run the standard walk.
 * Use SparseMerkleTree.verifyCompact() for this — identical security as
 * the full verify().
 */
export interface CompactSMTProof {
  key:   string;
  value: string | null;
  /**
   * Sparse sibling list: only entries where hash ≠ EMPTY_HASHES[255 − depth].
   * Sorted ascending by depth for deterministic encoding.
   */
  siblings: Array<{ depth: number; hash: string }>;
  root: string;
  /** Original proof length (always 256) — lets clients validate expansion. */
  fullDepth: 256;
}

// ── Sparse Merkle Tree ────────────────────────────────────────────────────────

/**
 * Sparse Merkle Tree over a 256-bit key space.
 *
 * Keys and values MUST be 64-char hex strings (32 bytes each).
 * Mutation invalidates the cached root; `root()` recomputes lazily.
 */
export class SparseMerkleTree {
  private readonly leaves = new Map<string, string>(); // key64 → value64
  private readonly nodeCache = new Map<string, string>(); // "${depth}:${prefix}" → hash64
  private _root: string | null = null;

  // ── Mutations ───────────────────────────────────────────────────────────────

  set(key: string, value: string): void {
    this.leaves.set(key, value);
    this._invalidate();
  }

  delete(key: string): void {
    if (this.leaves.delete(key)) this._invalidate();
  }

  has(key: string): boolean {
    return this.leaves.has(key);
  }

  get size(): number {
    return this.leaves.size;
  }

  // ── Root ────────────────────────────────────────────────────────────────────

  /** Compute (or return cached) Merkle root of the full tree. */
  root(): string {
    if (this._root !== null) return this._root;
    const entries = [...this.leaves.entries()];
    this._root = this._subtreeRoot(0, BigInt(0), entries);
    return this._root;
  }

  // ── Proof generation ────────────────────────────────────────────────────────

  /**
   * Generate a Merkle proof for `key`.
   * Works for both members (value ≠ null) and non-members (value = null).
   * Warms the node cache as a side effect, so subsequent prove() calls
   * for other keys are fast.
   */
  prove(key: string): SMTProof {
    const root = this.root(); // warm cache
    const keyBuf = Buffer.from(key, "hex");
    const siblings: string[] = new Array(256);
    const entries = [...this.leaves.entries()];
    this._collectSiblings(keyBuf, 0, BigInt(0), entries, siblings);
    return {
      key,
      value: this.leaves.get(key) ?? null,
      siblings,
      root,
    };
  }

  /**
   * Generate a compact proof for `key`.
   *
   * Identical cryptographic security as prove() — the compact form is a
   * lossless compression of the full proof. Reduces proof size from 8 KB
   * to O(log n × 32 bytes) for sparse trees.
   *
   * Mobile nodes should always request compact proofs; full proofs are
   * available for backwards compatibility with existing clients.
   */
  proveCompact(key: string): CompactSMTProof {
    const full = this.prove(key);
    const sparse: Array<{ depth: number; hash: string }> = [];
    for (let d = 0; d < 256; d++) {
      const sibling = full.siblings[d]!;
      // At depth d, an empty sibling subtree has hash EMPTY_HASHES[256-(d+1)] = EMPTY_HASHES[255-d]
      if (sibling !== EMPTY_HASHES[255 - d]) {
        sparse.push({ depth: d, hash: sibling });
      }
    }
    return {
      key:       full.key,
      value:     full.value,
      siblings:  sparse,
      root:      full.root,
      fullDepth: 256,
    };
  }

  // ── Proof verification (static) ──────────────────────────────────────────────

  /**
   * Verify a compact proof against a known root.
   *
   * Expands sparse siblings back to the full 256-length array, filling
   * missing positions with EMPTY_HASHES[255 − depth], then delegates to
   * the standard verify(). Identical security guarantee — the expansion
   * is deterministic and fully determined by EMPTY_HASHES.
   *
   * Mobile light nodes should call this instead of verify() to save bandwidth.
   */
  static verifyCompact(proof: CompactSMTProof, expectedRoot: string): boolean {
    // Expand: start with all-empty siblings, overlay the non-default entries
    const siblings = new Array<string>(256);
    for (let d = 0; d < 256; d++) {
      siblings[d] = EMPTY_HASHES[255 - d]!;
    }
    for (const { depth, hash } of proof.siblings) {
      if (depth >= 0 && depth < 256) siblings[depth] = hash;
    }
    return SparseMerkleTree.verify(
      { key: proof.key, value: proof.value, siblings, root: proof.root },
      expectedRoot,
    );
  }

  /**
   * Verify a proof against a known root.
   * Returns true for membership proofs (value ≠ null) and
   * non-membership proofs (value = null, proving the key is absent).
   *
   * Pure function — can be called on a mobile client without a full node.
   */
  static verify(proof: SMTProof, expectedRoot: string): boolean {
    const keyBuf = Buffer.from(proof.key, "hex");
    let current: string;

    if (proof.value !== null) {
      current = hashLeaf(keyBuf, Buffer.from(proof.value, "hex"));
    } else {
      // Non-membership: path leads to an empty leaf slot
      current = EMPTY_HASHES[0]!;
    }

    // Walk from leaf (depth 255) up to root (depth 0)
    for (let i = 255; i >= 0; i--) {
      const sibling = proof.siblings[i]!;
      const sibBuf = Buffer.from(sibling, "hex");
      const curBuf = Buffer.from(current, "hex");
      const bit = getBit(keyBuf, i);
      current = bit === 0
        ? hashInternal(curBuf, sibBuf)
        : hashInternal(sibBuf, curBuf);
    }

    return current === expectedRoot;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _invalidate(): void {
    this._root = null;
    this.nodeCache.clear();
  }

  /**
   * Recursively compute the root hash of a subtree.
   * `depth`   — current bit position being decided (0 = root split)
   * `prefix`  — path prefix accumulated so far (for cache key uniqueness)
   * `entries` — the leaves that fall inside this subtree
   */
  private _subtreeRoot(
    depth: number,
    prefix: bigint,
    entries: [string, string][],
  ): string {
    if (entries.length === 0) {
      // Empty subtree: return precomputed empty hash for this height
      return EMPTY_HASHES[256 - depth]!;
    }
    if (depth === 256) {
      // Leaf level — there must be exactly one entry here
      const [key, value] = entries[0]!;
      return hashLeaf(Buffer.from(key, "hex"), Buffer.from(value, "hex"));
    }

    const cacheKey = `${depth}:${prefix}`;
    const cached = this.nodeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const left: [string, string][] = [];
    const right: [string, string][] = [];
    for (const [k, v] of entries) {
      if (getBit(Buffer.from(k, "hex"), depth) === 0) left.push([k, v]);
      else right.push([k, v]);
    }

    const leftHash = this._subtreeRoot(depth + 1, prefix * 2n, left);
    const rightHash = this._subtreeRoot(depth + 1, prefix * 2n + 1n, right);
    const result = hashInternal(
      Buffer.from(leftHash, "hex"),
      Buffer.from(rightHash, "hex"),
    );
    this.nodeCache.set(cacheKey, result);
    return result;
  }

  /**
   * Walk the tree along `keyBuf`'s path, collecting the sibling hash at each
   * level into `out[depth]`. Called after `root()` to reuse the warm cache.
   */
  private _collectSiblings(
    keyBuf: Buffer,
    depth: number,
    prefix: bigint,
    entries: [string, string][],
    out: string[],
  ): void {
    if (depth === 256) return;

    const left: [string, string][] = [];
    const right: [string, string][] = [];
    for (const [k, v] of entries) {
      if (getBit(Buffer.from(k, "hex"), depth) === 0) left.push([k, v]);
      else right.push([k, v]);
    }

    const bit = getBit(keyBuf, depth);
    if (bit === 0) {
      out[depth] = this._subtreeRoot(depth + 1, prefix * 2n + 1n, right);
      this._collectSiblings(keyBuf, depth + 1, prefix * 2n, left, out);
    } else {
      out[depth] = this._subtreeRoot(depth + 1, prefix * 2n, left);
      this._collectSiblings(keyBuf, depth + 1, prefix * 2n + 1n, right, out);
    }
  }
}

// ── Key / value derivation helpers ───────────────────────────────────────────

/**
 * Derive a 64-char hex SMT key from a domain prefix and an identifier.
 * Domain prefixes prevent key collisions across different state partitions:
 *   "acct"     — account balance + nonce
 *   "utxo"     — unspent transaction output
 *   "contract" — WASM contract storage hash
 */
export function smtKey(domain: string, identifier: string): string {
  return createHash("sha256")
    .update(domain + ":" + identifier)
    .digest("hex");
}

/**
 * Derive a 64-char hex SMT value by hashing structured state data.
 * The input string should encode all relevant fields, e.g. "balance:nonce".
 */
export function smtValue(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
