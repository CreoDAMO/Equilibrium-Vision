import {
  pgTable,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── dex_pools ─────────────────────────────────────────────────────────────────
//
// Persists DEX AMM pool state across server restarts.
// Pools seeded from genesis.json survive immediately; runtime-created pools
// (via POST /dex/pools/seed-arbitrage-demo) are now also durable.

export const dexPoolsTable = pgTable(
  "dex_pools",
  {
    id:             text("id").primaryKey(),
    tokenA:         text("token_a").notNull(),
    tokenB:         text("token_b").notNull(),
    reserveA:       numeric("reserve_a", { precision: 36, scale: 0 }).notNull(),
    reserveB:       numeric("reserve_b", { precision: 36, scale: 0 }).notNull(),
    totalLiquidity: numeric("total_liquidity", { precision: 36, scale: 0 }).notNull(),
    fee:            numeric("fee", { precision: 10, scale: 6 }).notNull().default("0.003"),
    volumeA:        numeric("volume_a", { precision: 36, scale: 0 }).notNull().default("0"),
    volumeB:        numeric("volume_b", { precision: 36, scale: 0 }).notNull().default("0"),
    txCount:        numeric("tx_count", { precision: 20, scale: 0 }).notNull().default("0"),
    createdAt:      timestamp("created_at").defaultNow(),
    updatedAt:      timestamp("updated_at").defaultNow(),
  },
  (t) => [
    index("dex_pools_token_a_idx").on(t.tokenA),
    index("dex_pools_token_b_idx").on(t.tokenB),
  ],
);

export const insertDexPoolSchema = createInsertSchema(dexPoolsTable);
export type InsertDexPool = z.infer<typeof insertDexPoolSchema>;
export type DexPoolRow = typeof dexPoolsTable.$inferSelect;
