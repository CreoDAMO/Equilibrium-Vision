/**
 * What a version-1 transition proof is allowed to claim.
 * The target is a faithful proof of this relation. It is not a stronger one.
 */
export const V1_RELATION_ID = "faithful-v1";

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
