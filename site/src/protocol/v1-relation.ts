/**
 * What the version-1 proof is allowed to claim.
 * The identifier names one descriptor. The pin names its bytes.
 * A change to the descriptor needs a new identifier. The old pin stays.
 */
import { sha256Hex } from "./crypto";

type Canon = string | { readonly [key: string]: Canon };

export const V1_RELATION_ID = "faithful-v1.1";

/** The descriptor named by `faithful-v1`, frozen. It is not the current relation. */
export const FAITHFUL_V1 = {
  id: "faithful-v1",
  target: "faithful-proof-of-the-production-relation",
  couplings: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "five finite fields, each at least zero, as the predecessor opened them",
    excludes: "an upper bound, and that every product inside the residual stays finite",
  },
  btcHeaders: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the header is 80 bytes, extends the previous header, and meets its own target",
    excludes: "membership in the canonical Bitcoin chain",
  },
  ethBeacon: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "signatures and participation of the committee already in the state, and continuity from it",
    excludes: "that the committee is Ethereum's canonical sync committee",
  },
  ethExecution: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the execution header is well formed and extends the parent at the next height",
    excludes: "that the receipts belong to a finalized Ethereum execution block",
  },
  models: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the registry record matches its identifiers, URI, residual fingerprint, and support hash",
    excludes: "that the model was executed and produced that residual",
  },
  settlements: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the local release rule against the settlement record and the header window",
    excludes: "that the foreign payment occurred",
  },
} as const;

export const V1_RELATION = {
  id: V1_RELATION_ID,
  target: "faithful-proof-of-the-production-relation",
  couplings: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "five finite fields, each at least zero, as the predecessor opened them",
    excludes: "an upper bound, and that every product inside the residual stays finite",
  },
  btcHeaders: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the header is 80 bytes, extends the previous header, and meets its own target",
    excludes: "membership in the canonical Bitcoin chain",
  },
  ethBeacon: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    bootstrap: {
      claims: "the transition admits the first committee into the state",
      excludes: "that the committee is Ethereum's canonical sync committee",
    },
    subsequent: {
      claims: "a later header is checked against the committee already in the state",
      excludes: "that the committee is Ethereum's canonical sync committee",
    },
  },
  ethExecution: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the execution header is well formed and extends the parent at the next height",
    excludes: "that the receipts belong to a finalized Ethereum execution block",
  },
  models: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the registry record matches its identifiers, URI, residual fingerprint, and support hash",
    excludes: "that the model was executed and produced that residual",
  },
  settlements: {
    outcome: "RETAIN-WITH-DISCLAIMER",
    claims: "the local release rule against the settlement record and the header window",
    excludes: "that the foreign payment occurred",
  },
} as const;

/** String is tag 1. Object is tag 2. Object keys are sorted. Lengths are little-endian. */
export function canonicalBytes(value: Canon): Uint8Array {
  if (typeof value === "string") {
    const utf8 = new TextEncoder().encode(value);
    const out = new Uint8Array(5 + utf8.length);
    out[0] = 1;
    new DataView(out.buffer).setUint32(1, utf8.length, true);
    out.set(utf8, 5);
    return out;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => concat(canonicalBytes(key), canonicalBytes(value[key]!)));
  const body = concat(...parts);
  const out = new Uint8Array(5 + body.length);
  out[0] = 2;
  new DataView(out.buffer).setUint32(1, keys.length, true);
  out.set(body, 5);
  return out;
}

export function descriptorDigest(value: Canon): string {
  return sha256Hex(canonicalBytes(value));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
