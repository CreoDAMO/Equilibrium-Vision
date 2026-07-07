import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { asc, eq } from "drizzle-orm";
import { blocksTable, transactionsTable, contractsTable } from "@workspace/db/schema";
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
    _db = drizzle(pool, { schema: { blocksTable, transactionsTable, contractsTable } }) as unknown as Db;
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
    // A partial write (crash mid-genesis persist) produces a gap; we fall back
    // to in-memory genesis rather than replaying a broken chain.
    for (let i = 0; i < dbBlocks.length; i++) {
      const b = dbBlocks[i]!;
      if (b.height !== i) {
        logger.warn({ expected: i, got: b.height }, "Chain integrity check failed: height gap — falling back to genesis");
        return null;
      }
      if (i > 0 && b.prevHash !== dbBlocks[i - 1]!.hash) {
        logger.warn({ height: i }, "Chain integrity check failed: prevHash mismatch — falling back to genesis");
        return null;
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

    return dbBlocks.map((b) => ({
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

/**
 * Load all deployed contracts from DB on startup.
 * Returns an empty array if Postgres is unavailable.
 */
export async function loadContractsFromDb(): Promise<ContractRecord[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db.select().from(contractsTable);
    return rows.map((r) => ({
      address:      r.address,
      deployer:     r.deployer,
      bytecode:     r.bytecode,
      bytecodeHash: r.bytecodeHash,
      storage:      (r.storage as Record<string, string>) ?? {},
      deployedAt:   r.deployedAt,
      callCount:    r.callCount,
      totalGasUsed: r.totalGasUsed,
      abi:          r.abi ?? undefined,
    }));
  } catch (err) {
    logger.warn({ err }, "Failed to load contracts from DB — starting with empty contract set");
    return [];
  }
}
