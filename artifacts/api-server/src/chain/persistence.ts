import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { blocksTable, transactionsTable, contractsTable, stateSnapshotsTable } from "@workspace/db/schema";
import type { BlockRecord, TxRecord } from "./types.js";
import type { ContractRecord } from "./wasm.js";
import { logger } from "../lib/logger.js";

// ── Self-contained persistence layer ─────────────────────────────────────────
//
// Creates its own drizzle/pg client so this module is fully optional:
// if DATABASE_URL is not set the entire persistence path is skipped and the
// server runs in pure in-memory mode exactly as before.
//
// Import @workspace/db/schema (table definitions only — no pg Pool init)
// so we get the Drizzle table objects without the throw in db/src/index.ts.

const { Pool } = pg;

type Db = ReturnType<typeof drizzle<{
  blocksTable: typeof blocksTable;
  transactionsTable: typeof transactionsTable;
  contractsTable: typeof contractsTable;
  stateSnapshotsTable: typeof stateSnapshotsTable;
}>>;

let _db: Db | null = null;
let _initDone = false;

/** Lazy singleton — returns null when DATABASE_URL is absent.
 *  Does NOT cache null on failure so a transient startup race
 *  (Postgres not yet ready) is retried on the next call. */
function getDb(): Db | null {
  if (_initDone) return _db;

  const url = process.env["DATABASE_URL"];
  if (!url) {
    // No URL configured — settle into in-memory mode permanently.
    _initDone = true;
    logger.info("DATABASE_URL not set — running in-memory mode (chain will not survive restarts)");
    return null;
  }

  try {
    const pool = new Pool({ connectionString: url });
    _db = drizzle(pool, { schema: { blocksTable, transactionsTable, contractsTable, stateSnapshotsTable } }) as unknown as Db;
    // Only mark done once we have a real db handle.
    _initDone = true;
    logger.info({ url: url.replace(/:[^@]*@/, ":***@") }, "Postgres persistence enabled");
    return _db;
  } catch (err) {
    // Leave _initDone = false so the next call retries.
    logger.warn({ err }, "Failed to initialise Postgres pool — will retry on next access");
    return null;
  }
}

// ── Row → domain type helpers ─────────────────────────────────────────────────

function toTxRecord(row: typeof transactionsTable.$inferSelect): TxRecord {
  return {
    hash:        row.hash,
    from:        row.from,
    to:          row.to,
    amount:      row.amount,
    fee:         row.fee,
    nonce:       row.nonce,
    status:      row.status as TxRecord["status"],
    timestamp:   row.timestamp,
    blockHash:   row.blockHash   ?? null,
    blockHeight: row.blockHeight ?? null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Load all persisted blocks (ordered by height) plus their confirmed
 * transactions.  Returns null if Postgres is unavailable or the DB is empty
 * (caller should fall back to buildGenesisChain).
 */
export async function loadBlocksFromDb(): Promise<BlockRecord[] | null> {
  const db = getDb();
  if (!db) return null;

  try {
    const [dbBlocks, dbTxs] = await Promise.all([
      db.select().from(blocksTable).orderBy(asc(blocksTable.height)),
      db.select().from(transactionsTable).where(eq(transactionsTable.status, "confirmed")),
    ]);

    if (dbBlocks.length === 0) return null; // empty DB → generate genesis

    // ── Chain integrity check ────────────────────────────────────────────────
    // Validate contiguous heights and prevHash linkage before accepting DB data.
    // A partial write (crash mid-genesis persist, or schema not yet applied on
    // first boot) can produce a gap.  Rather than falling back to genesis and
    // discarding all history, we truncate to the longest contiguous sequence
    // from height 0 so any valid history is preserved.
    //
    // Exception: if the very first block isn't height 0 we have no base to
    // build on, so fall back to genesis.
    if (dbBlocks[0]!.height !== 0) {
      logger.warn({ got: dbBlocks[0]!.height }, "Chain integrity check failed: missing genesis block — falling back to genesis");
      return null;
    }
    let contiguousEnd = dbBlocks.length; // exclusive index of first broken block
    for (let i = 1; i < dbBlocks.length; i++) {
      const b = dbBlocks[i]!;
      if (b.height !== i) {
        logger.warn(
          { expected: i, got: b.height, truncatingAt: i },
          "Chain integrity: height gap detected — truncating to last contiguous block",
        );
        contiguousEnd = i;
        break;
      }
      if (b.prevHash !== dbBlocks[i - 1]!.hash) {
        logger.warn(
          { height: i, truncatingAt: i },
          "Chain integrity: prevHash mismatch — truncating to last contiguous block",
        );
        contiguousEnd = i;
        break;
      }
    }
    // Drop any blocks beyond the first integrity violation — both in memory
    // and in the DB so subsequent restarts don't re-hit the same truncation.
    const validBlocks = dbBlocks.slice(0, contiguousEnd);
    if (contiguousEnd < dbBlocks.length) {
      const cutHeight = contiguousEnd; // first invalid height
      try {
        const db2 = getDb()!;
        await db2.transaction(async (tx) => {
          // Delete orphaned transactions first (FK-safe order).
          await tx.delete(transactionsTable).where(gte(transactionsTable.blockHeight, cutHeight));
          await tx.delete(blocksTable).where(gte(blocksTable.height, cutHeight));
        });
        logger.info({ deletedFrom: cutHeight }, "Pruned invalid chain suffix from DB");
      } catch (pruneErr) {
        // Non-fatal — in-memory chain is still correct; next restart will
        // re-truncate until the prune eventually succeeds.
        logger.warn({ pruneErr }, "Failed to prune invalid chain suffix from DB (will retry)");
      }
    }

    // Group txs by blockHash for O(1) lookup
    const txsByBlock = new Map<string, TxRecord[]>();
    for (const row of dbTxs) {
      if (!row.blockHash) continue;
      const list = txsByBlock.get(row.blockHash) ?? [];
      list.push(toTxRecord(row));
      txsByBlock.set(row.blockHash, list);
    }

    return validBlocks.map((b) => ({
      hash:          b.hash,
      height:        b.height,
      prevHash:      b.prevHash,
      merkleRoot:    b.merkleRoot,
      timestamp:     b.timestamp,
      nonce:         b.nonce,
      difficulty:    b.difficulty,
      residual:      b.residual,
      // Fall back to float conversion for rows written before residualFp was added.
      residualFp:    b.residualFp ?? Math.floor(b.residual * 1e18),
      stateRoot:     b.stateRoot ?? undefined,
      recursionDepth: 2,
      coinbaseReward: b.coinbaseReward,
      miner:         b.miner,
      txCount:       b.txCount,
      transactions:  txsByBlock.get(b.hash) ?? [],
      finalized:     b.finalized,
      zkProof:       (b.zkProof as BlockRecord["zkProof"]) ?? undefined,
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to load chain from Postgres — falling back to genesis");
    return null;
  }
}

/**
 * Persist a single block and its confirmed transactions.
 * Uses INSERT … ON CONFLICT DO NOTHING so replayed or duplicate blocks are
 * silently skipped.  Errors are logged but never thrown — persistence is
 * best-effort and must not crash the mining loop.
 */
export async function persistBlock(block: BlockRecord): Promise<void> {
  const db = getDb();
  if (!db) return;

  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(blocksTable)
        .values({
          hash:           block.hash,
          height:         block.height,
          prevHash:       block.prevHash,
          merkleRoot:     block.merkleRoot,
          timestamp:      block.timestamp,
          nonce:          block.nonce,
          difficulty:     block.difficulty,
          residual:       block.residual,
          residualFp:     block.residualFp ?? Math.floor(block.residual * 1e18),
          miner:          block.miner,
          txCount:        block.txCount,
          coinbaseReward: block.coinbaseReward,
          finalized:      block.finalized ?? false,
          zkProof:        (block.zkProof ?? null) as unknown as null,
          stateRoot:      block.stateRoot ?? null,
        })
        .onConflictDoNothing();

      if (block.transactions.length > 0) {
        await tx
          .insert(transactionsTable)
          .values(
            block.transactions.map((t) => ({
              hash:        t.hash,
              blockHash:   block.hash,
              blockHeight: block.height,
              from:        t.from,
              to:          t.to,
              amount:      t.amount,
              fee:         t.fee,
              nonce:       t.nonce,
              signature:   "",   // TxRecord has no signature field; placeholder for schema NOT NULL
              status:      "confirmed" as const,
              timestamp:   t.timestamp,
            })),
          )
          .onConflictDoNothing();
      }
    });
  } catch (err) {
    logger.warn({ err, height: block.height, hash: block.hash }, "Failed to persist block — will retry next restart");
  }
}

/**
 * Bulk-persist an ordered list of blocks (used to save the genesis chain on
 * first boot).  Blocks are written sequentially to keep the DB consistent.
 */
export async function persistBlocks(blocks: BlockRecord[]): Promise<void> {
  for (const block of blocks) {
    await persistBlock(block);
  }
}

/** True when a Postgres connection is available. */
export function isDbAvailable(): boolean {
  return getDb() !== null;
}

// ── Smart contract persistence ────────────────────────────────────────────────

/**
 * Upsert a contract record (deploy or post-call storage update).
 * Uses ON CONFLICT DO UPDATE so both new deploys and storage mutations
 * are handled with a single call.  Fire-and-forget safe — never throws.
 */
export async function persistContract(contract: ContractRecord): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(contractsTable)
      .values({
        address:      contract.address,
        deployer:     contract.deployer,
        bytecode:     contract.bytecode,
        bytecodeHash: contract.bytecodeHash,
        storage:      contract.storage,
        deployedAt:   contract.deployedAt,
        callCount:    contract.callCount,
        totalGasUsed: contract.totalGasUsed,
        abi:          contract.abi ?? null,
      })
      .onConflictDoUpdate({
        target: contractsTable.address,
        set: {
          storage:      contract.storage,
          callCount:    contract.callCount,
          totalGasUsed: contract.totalGasUsed,
        },
      });
  } catch (err) {
    logger.warn({ err, address: contract.address }, "Failed to persist contract");
  }
}

function rowToContractRecord(r: typeof contractsTable.$inferSelect): ContractRecord {
  return {
    address:      r.address,
    deployer:     r.deployer,
    bytecode:     r.bytecode,
    bytecodeHash: r.bytecodeHash,
    storage:      (r.storage as Record<string, string>) ?? {},
    deployedAt:   r.deployedAt,
    callCount:    r.callCount,
    totalGasUsed: r.totalGasUsed,
    abi:          r.abi ?? undefined,
  };
}

/**
 * Load all deployed contracts from DB on startup, newest first.
 * Returns an empty array if Postgres is unavailable.
 */
export async function loadContractsFromDb(): Promise<ContractRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(contractsTable)
      .orderBy(desc(contractsTable.deployedAt));
    return rows.map(rowToContractRecord);
  } catch (err) {
    logger.warn({ err }, "Failed to load contracts from DB — starting with empty contract set");
    return [];
  }
}

// ── State snapshots ───────────────────────────────────────────────────────────
//
// A snapshot captures the full ledger + UTXO set at a given block height so
// that old block rows can be safely deleted without losing the ability to
// reconstruct the live state on restart.
//
// Contract storage is NOT included — it is already durable in the `contracts`
// table's JSONB `storage` column and is loaded separately.

/** Serialised form passed between chain/index.ts and persistence.ts. */
export interface StateSnapshotData {
  height:    number;
  blockHash: string;
  stateRoot: string;
  ledger:    Record<string, { balance: number; nonce: number }>;
  utxos:     Array<{
    txHash:      string;
    outputIndex: number;
    address:     string;
    amount:      number;
    coinbase:    boolean;
    blockHeight: number;
  }>;
}

/**
 * Upsert a state snapshot for the given block height.
 * Called by chain/index.ts every SNAPSHOT_INTERVAL blocks and before pruning.
 */
export async function saveStateSnapshot(data: StateSnapshotData): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(stateSnapshotsTable)
      .values({
        height:    data.height,
        blockHash: data.blockHash,
        stateRoot: data.stateRoot,
        ledger:    data.ledger,
        utxos:     data.utxos,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: stateSnapshotsTable.height,
        set: {
          blockHash: data.blockHash,
          stateRoot: data.stateRoot,
          ledger:    data.ledger,
          utxos:     data.utxos,
          createdAt: Date.now(),
        },
      });
    logger.info({ height: data.height }, "State snapshot saved");
  } catch (err) {
    logger.warn({ err, height: data.height }, "Failed to save state snapshot");
  }
}

/** Return the most recent state snapshot, or null if none exists. */
export async function loadLatestSnapshot(): Promise<StateSnapshotData | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(stateSnapshotsTable)
      .orderBy(desc(stateSnapshotsTable.height))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      height:    row.height,
      blockHash: row.blockHash,
      stateRoot: row.stateRoot,
      ledger:    row.ledger as StateSnapshotData["ledger"],
      utxos:     row.utxos  as StateSnapshotData["utxos"],
    };
  } catch (err) {
    logger.warn({ err }, "Failed to load state snapshot");
    return null;
  }
}

/**
 * Load ALL blocks from Postgres ordered by height without gap validation.
 * Used by initChain when restoring from a snapshot: the caller is responsible
 * for gap handling (replaying only post-snapshot blocks).
 * Returns null when Postgres is unavailable or the table is empty.
 */
export async function loadAllBlocksRaw(): Promise<BlockRecord[] | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const blockRows = await db
      .select()
      .from(blocksTable)
      .orderBy(asc(blocksTable.height));
    if (blockRows.length === 0) return null;

    const txRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.status, "confirmed"))
      .orderBy(asc(transactionsTable.blockHeight));

    const txByBlock = new Map<string, TxRecord[]>();
    for (const row of txRows) {
      if (!row.blockHash) continue;
      const tx = toTxRecord(row);
      if (!txByBlock.has(row.blockHash)) txByBlock.set(row.blockHash, []);
      txByBlock.get(row.blockHash)!.push(tx);
    }

    return blockRows.map((b) => ({
      hash:          b.hash,
      height:        b.height,
      prevHash:      b.prevHash,
      merkleRoot:    b.merkleRoot,
      timestamp:     b.timestamp,
      nonce:         b.nonce,
      difficulty:    b.difficulty,
      residual:      b.residual,
      residualFp:    b.residualFp ?? undefined,
      recursionDepth: 2,
      miner:         b.miner,
      txCount:       b.txCount,
      coinbaseReward: b.coinbaseReward,
      finalized:     b.finalized,
      zkProof:       b.zkProof as BlockRecord["zkProof"],
      stateRoot:     b.stateRoot ?? undefined,
      transactions:  txByBlock.get(b.hash) ?? [],
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to load raw blocks");
    return null;
  }
}

// ── Block pruning ─────────────────────────────────────────────────────────────
//
// Allows mobile nodes and storage-constrained deployments to shed old block
// data while keeping the chain verifiable from the pruned tip.
//
// Strategy: keep the last `keepBlocks` blocks in full; discard anything older.
// The genesis block (height 0) is always kept.
//
// Safe pruning requires a durable state snapshot at or above the prune
// boundary.  Call saveStateSnapshot() before pruning, or use the
// safelyPruneOldBlocks() helper in chain/index.ts which does both.

/** Default number of blocks to retain. ~7 days at 15 s/block. */
export const DEFAULT_PRUNE_KEEP = 40_320;

/**
 * Prune blocks older than `keepBlocks` from Postgres.
 * Refuses (returns 0) when no snapshot covers the prune boundary — this
 * prevents a restart from being unable to reconstruct state.
 * Returns the number of blocks deleted.
 */
export async function pruneOldBlocks(keepBlocks = DEFAULT_PRUNE_KEEP): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  try {
    const tipRows = await db
      .select({ height: blocksTable.height })
      .from(blocksTable)
      .orderBy(desc(blocksTable.height))
      .limit(1);

    const tipHeight = tipRows[0]?.height ?? 0;
    const pruneBelow = tipHeight - keepBlocks;
    if (pruneBelow <= 0) return 0; // nothing to prune

    // Require a snapshot at or above the prune boundary so a restart can
    // reconstruct state from snapshot + retained blocks rather than a full
    // block replay.
    const snapRows = await db
      .select({ height: stateSnapshotsTable.height })
      .from(stateSnapshotsTable)
      .orderBy(desc(stateSnapshotsTable.height))
      .limit(1);

    const snapHeight = snapRows[0]?.height ?? -1;
    if (snapHeight < pruneBelow - 1) {
      // ENABLE_UNSAFE_PRUNING bypass for disposable/testing nodes.
      if (process.env["ENABLE_UNSAFE_PRUNING"] !== "true") {
        logger.warn(
          { pruneBelow, snapHeight },
          "Block pruning skipped: no state snapshot covers the prune boundary. " +
          "Call safelyPruneOldBlocks() from chain/index.ts (saves snapshot automatically), " +
          "or set ENABLE_UNSAFE_PRUNING=true only for disposable nodes.",
        );
        return 0;
      }
      logger.warn(
        { pruneBelow, snapHeight },
        "ENABLE_UNSAFE_PRUNING=true — pruning without a valid snapshot (restart will lose state)",
      );
    }

    // Delete blocks with height in (0, pruneBelow) — never prune genesis (0).
    // The FK cascade on transactions removes their rows automatically.
    const result = await db
      .delete(blocksTable)
      .where(and(
        gte(blocksTable.height, 1),
        lt(blocksTable.height, pruneBelow),
      ));

    const count = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    logger.info({ pruneBelow, tipHeight, keepBlocks, deleted: count }, "Block pruning complete");
    return count;
  } catch (err) {
    logger.warn({ err }, "Block pruning failed");
    return 0;
  }
}

/**
 * Load contracts deployed by a specific address, newest first.
 * Uses the contracts_deployer_idx index — O(k) where k = contracts by that deployer.
 */
export async function loadContractsByDeployer(deployer: string): Promise<ContractRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select()
      .from(contractsTable)
      .where(eq(contractsTable.deployer, deployer))
      .orderBy(desc(contractsTable.deployedAt));
    return rows.map(rowToContractRecord);
  } catch (err) {
    logger.warn({ err, deployer }, "Failed to load contracts by deployer");
    return [];
  }
}
