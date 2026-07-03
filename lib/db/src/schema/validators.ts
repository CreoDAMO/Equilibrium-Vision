import {
  pgTable,
  text,
  bigint,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ── validators ────────────────────────────────────────────────────────────────

export const validatorsTable = pgTable(
  "validators",
  {
    address:        text("address").primaryKey(),
    stake:          bigint("stake", { mode: "number" }).notNull().default(0),
    delegatedStake: bigint("delegated_stake", { mode: "number" }).notNull().default(0),
    active:         boolean("active").notNull().default(true),
    slashCount:     bigint("slash_count", { mode: "number" }).notNull().default(0),
    /** Unix timestamp of last observed activity */
    lastSeen:       bigint("last_seen", { mode: "number" }),
  },
  (t) => [
    index("validators_active_idx").on(t.active),
    index("validators_stake_idx").on(t.stake),
  ],
);

export const insertValidatorSchema = createInsertSchema(validatorsTable);
export type InsertValidator = z.infer<typeof insertValidatorSchema>;
export type Validator = typeof validatorsTable.$inferSelect;
