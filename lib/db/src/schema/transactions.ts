import {
  pgTable,
  text,
  integer,
  bigint,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── transactions ──────────────────────────────────────────────────────────────

export const transactionsTable = pgTable(
  "transactions",
  {
    hash:        text("hash").primaryKey(),
    blockHash:   text("block_hash"),          // null if still in mempool
    blockHeight: integer("block_height"),     // null if still in mempool
    from:        text("from_address").notNull(),
    to:          text("to_address").notNull(),
    amount:      bigint("amount", { mode: "number" }).notNull(),
    fee:         bigint("fee", { mode: "number" }).notNull().default(0),
    nonce:       bigint("nonce", { mode: "number" }).notNull(),
    signature:   text("signature").notNull(),
    /** "pending" | "confirmed" | "failed" */
    status:      text("status").notNull().default("pending"),
    timestamp:   bigint("timestamp", { mode: "number" }).notNull(),
  },
  (t) => [
    index("tx_block_hash_idx").on(t.blockHash),
    index("tx_from_idx").on(t.from),
    index("tx_to_idx").on(t.to),
    index("tx_status_idx").on(t.status),
  ],
);

export const insertTransactionSchema = createInsertSchema(transactionsTable);
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
