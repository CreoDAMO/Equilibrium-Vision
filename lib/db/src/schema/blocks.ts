import {
  pgTable,
  text,
  integer,
  bigint,
  real,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── blocks ────────────────────────────────────────────────────────────────────

export const blocksTable = pgTable(
  "blocks",
  {
    hash:          text("hash").primaryKey(),
    height:        integer("height").notNull(),
    prevHash:      text("prev_hash").notNull(),
    merkleRoot:    text("merkle_root").notNull(),
    timestamp:     bigint("timestamp", { mode: "number" }).notNull(),
    nonce:         bigint("nonce", { mode: "number" }).notNull(),
    difficulty:    real("difficulty").notNull(),
    residual:      real("residual").notNull(),
    miner:         text("miner").notNull(),
    txCount:       integer("tx_count").notNull().default(0),
    coinbaseReward: bigint("coinbase_reward", { mode: "number" }).notNull().default(0),
    finalized:     boolean("finalized").notNull().default(false),
    /** Serialised ZkProof JSON for the stationarity proof */
    zkProof:       jsonb("zk_proof"),
  },
  (t) => [
    index("blocks_height_idx").on(t.height),
    index("blocks_miner_idx").on(t.miner),
  ],
);

export const insertBlockSchema = createInsertSchema(blocksTable);
export type InsertBlock = z.infer<typeof insertBlockSchema>;
export type Block = typeof blocksTable.$inferSelect;
