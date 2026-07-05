// Ed25519 batch signature verification.
//
// @noble/curves v2 does not ship a `verifyBatch` helper for ed25519 (that API
// only exists for BLS in this version), so we implement the standard
// small-random-scalar batch verification equation directly on top of the
// public `ed25519.Point` API:
//
//   For n signatures (R_i, s_i) over messages M_i with public keys A_i:
//     h_i = SHA-512(R_i || A_i || M_i) mod L
//   Pick small random scalars z_i (128-bit) and check:
//     8 * ( (sum z_i*s_i) * G )  ==  8 * ( sum(z_i*R_i) + sum(z_i*h_i*A_i) )
//   The factor of 8 clears the cofactor, matching RFC 8032 group law.
//
// This is the well-known Ed25519 batch verification algorithm (used by
// ed25519-donna, ref10, etc). It lets us verify many signatures with a single
// combined multi-scalar-multiplication instead of one full verification per
// signature, which is where the throughput win comes from.
//
// Safety: if the batch check fails, callers MUST fall back to verifying each
// signature individually (see `verifyEd25519BatchDetailed`) — a failing batch
// only proves *some* signature is invalid, not which one.

import { sha512 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { randomBytes } from "crypto";

const Point = ed25519.Point;
const CURVE_ORDER = Point.CURVE().n;

export interface BatchSigItem {
  sig: Uint8Array;
  message: Uint8Array;
  publicKey: Uint8Array;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(bytes[i]!);
  }
  return value;
}

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

/** 128-bit random scalar — sufficient security margin for batch verification. */
function randomScalar(): bigint {
  const b = randomBytes(16);
  const z = bytesToNumberLE(new Uint8Array(b));
  return z === 0n ? 1n : z;
}

/**
 * Verify a batch of Ed25519 signatures in one combined check.
 * Returns `true` only if every signature in the batch is valid.
 * Returns `false` (never throws) on malformed input.
 */
export function verifyEd25519Batch(items: BatchSigItem[]): boolean {
  if (items.length === 0) return true;
  if (items.length === 1) {
    return verifyOne(items[0]!);
  }

  try {
    let combinedPoint = Point.ZERO;
    let sTotal = 0n;

    for (const { sig, message, publicKey } of items) {
      if (sig.length !== 64) return false;
      const rBytes = sig.subarray(0, 32);
      const sBytes = sig.subarray(32, 64);
      const s = bytesToNumberLE(sBytes);
      if (s >= CURVE_ORDER) return false;

      const R = Point.fromBytes(rBytes, true);
      const A = Point.fromBytes(publicKey, true);
      const h = mod(
        bytesToNumberLE(sha512(concatBytes(rBytes, publicKey, message))),
        CURVE_ORDER
      );

      const z = randomScalar();
      combinedPoint = combinedPoint.add(R.multiply(z)).add(A.multiply(mod(z * h, CURVE_ORDER)));
      sTotal = mod(sTotal + mod(z * s, CURVE_ORDER), CURVE_ORDER);
    }

    const lhs = Point.BASE.multiply(sTotal).multiply(8n);
    const rhs = combinedPoint.multiply(8n);
    return lhs.equals(rhs);
  } catch {
    return false;
  }
}

function verifyOne(item: BatchSigItem): boolean {
  try {
    return ed25519.verify(item.sig, item.message, item.publicKey);
  } catch {
    return false;
  }
}

/**
 * Verify a batch, and if the combined check fails, fall back to verifying
 * each signature individually so callers can identify exactly which ones
 * are invalid. Returns a boolean array aligned with `items`.
 */
export function verifyEd25519BatchDetailed(items: BatchSigItem[]): boolean[] {
  if (items.length === 0) return [];
  if (verifyEd25519Batch(items)) {
    return items.map(() => true);
  }
  return items.map((item) => verifyOne(item));
}
