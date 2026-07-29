import {
  pgTable,
  text,
  bigint,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── smt_roots ─────────────────────────────────────────────────────────────────
//
// Records the Sparse Merkle Tree root after each block. Allows a restarted
// node to verify light-node proofs against the committed root without
// rebuilding the full SMT from scratch.
//
// Also used as a cross-check: if the root recomputed at startup does not match
// the last persisted root, the node logs a warning and rebuilds the SMT.

export const smtRootsTable = pgTable(
  "smt_roots",
  {
    height:    bigint("height", { mode: "number" }).primaryKey(),
    blockHash: text("block_hash").notNull(),
    stateRoot: text("state_root").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("smt_roots_block_hash_idx").on(t.blockHash),
  ],
);

export const insertSmtRootSchema = createInsertSchema(smtRootsTable);
export type InsertSmtRoot = z.infer<typeof insertSmtRootSchema>;
export type SmtRootRow = typeof smtRootsTable.$inferSelect;
