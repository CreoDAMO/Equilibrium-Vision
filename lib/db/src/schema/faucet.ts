import { pgTable, text, integer } from "drizzle-orm/pg-core";

export const faucetDripsTable = pgTable("faucet_drips", {
  address:     text("address").primaryKey(),
  lastDripAt:  integer("last_drip_at").notNull(),
});

export type FaucetDripRow = typeof faucetDripsTable.$inferSelect;
