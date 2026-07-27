import { pgTable, integer, text, bigint, jsonb, index } from "drizzle-orm/pg-core";

// ── Ledger snapshot types ─────────────────────────────────────────────────────

/** Serialised account state stored in the snapshot's `ledger` JSONB column. */
export interface LedgerSnapshot {
  [address: string]: { balance: number; nonce: number };
}

/** Serialised UTXO stored in the snapshot's `utxos` JSONB column. */
export interface UTXOSnapshot {
  txHash:      string;
  outputIndex: number;
  address:     string;
  amount:      number;
  coinbase:    boolean;
  blockHeight: number;
}

// ── state_snapshots table ─────────────────────────────────────────────────────
//
// A durable checkpoint of the full account ledger + UTXO set at a given block
// height.  Snapshots allow `pruneOldBlocks()` to delete historic block rows
// without losing the ability to reconstruct current state on restart.
//
// Contract storage is NOT included here — it is already persisted per-contract
// in the `contracts` table's `storage` JSONB column.
//
// One row per snapshot; the primary key is the block height so upserts are
// idempotent and a re-snapshot at the same height is safe.

export const stateSnapshotsTable = pgTable(
  "state_snapshots",
  {
    /** Block height at which this snapshot was taken. */
    height:    integer("height").primaryKey(),
    /** Hash of the block at `height` — used to cross-check on restore. */
    blockHash: text("block_hash").notNull(),
    /** SMT state root at `height` — validated during restore. */
    stateRoot: text("state_root").notNull(),
    /** Full ledger: address → { balance, nonce } */
    ledger:    jsonb("ledger").$type<LedgerSnapshot>().notNull(),
    /** All unspent UTXOs (coinbase + transfer outputs). */
    utxos:     jsonb("utxos").$type<UTXOSnapshot[]>().notNull(),
    /** Unix milliseconds when the snapshot was written. */
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (t) => [
    index("state_snapshots_height_idx").on(t.height),
  ],
);

export type StateSnapshot = typeof stateSnapshotsTable.$inferSelect;
