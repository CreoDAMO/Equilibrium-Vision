import { pgTable, text, integer, jsonb, index } from "drizzle-orm/pg-core";

export const contractsTable = pgTable("contracts", {
  address:      text("address").primaryKey(),
  deployer:     text("deployer").notNull(),
  bytecode:     text("bytecode").notNull(),
  bytecodeHash: text("bytecode_hash").notNull(),
  // JSONB — contract key-value storage (string → string)
  storage:      jsonb("storage")
                  .$type<Record<string, string>>()
                  .default({})
                  .notNull(),
  // Block height at deploy time (integer, not a Date)
  deployedAt:   integer("deployed_at").notNull(),
  callCount:    integer("call_count").default(0).notNull(),
  totalGasUsed: integer("total_gas_used").default(0).notNull(),
  // ABI as JSONB (nullable — not all contracts ship an ABI)
  abi:          jsonb("abi")
                  .$type<{
                    functions: Array<{
                      name: string;
                      methodId: number;
                      inputs: string[];
                      outputs: string[];
                    }>;
                  } | null>()
                  .default(null),
}, (table) => [
  // Speeds up filtering/listing contracts by deployer address
  index("contracts_deployer_idx").on(table.deployer),
  // Speeds up ORDER BY deployed_at DESC (default list sort)
  index("contracts_deployed_at_idx").on(table.deployedAt),
]);

export type ContractRow = typeof contractsTable.$inferSelect;
