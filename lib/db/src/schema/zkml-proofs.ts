import { pgTable, integer, text, bigint, index } from "drizzle-orm/pg-core";

// ── zkml_proofs ───────────────────────────────────────────────────────────────
//
// Off-chain receipt store for RISC Zero zkML proofs submitted by the Rust
// model_registry_integration bridge (POST /api/models/:id/zkml-proof).
//
// The on-chain ModelRegistry contract only records Ed25519 inference
// attestations; zkML proof receipts are larger artifacts that live here.
// Keyed by modelId — one receipt per model (last one wins).

export const zkmlProofsTable = pgTable(
  "zkml_proofs",
  {
    modelId:      integer("model_id").primaryKey(),
    sealHex:      text("seal_hex").notNull(),
    journalHex:   text("journal_hex").notNull(),
    submittedAt:  bigint("submitted_at", { mode: "number" }).notNull(),
    // Optional self-describing fields sent by the Rust bridge
    modelRootHex: text("model_root_hex"),
    inputHashHex: text("input_hash_hex"),
    blockHeight:  integer("block_height"),
  },
  (t) => [
    index("zkml_proofs_submitted_at_idx").on(t.submittedAt),
  ],
);

export type ZkmlProofRow = typeof zkmlProofsTable.$inferSelect;
