import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { blocksTable, transactionsTable, contractsTable, stateSnapshotsTable, zkmlProofsTable } from "@workspace/db/schema";
import type { BlockRecord, TxRecord, DexPool, ValidatorRecord, StakeRecord, UnbondingEntry } from "./types.js";
import type { ContractRecord } from "./wasm.js";
import { asBlockNonce } from "../../../../site/src/protocol/domain.js";
import { omegaRecord } from "../../../../site/src/protocol/seal.js";
import { logger } from "../lib/logger.js";
import { snapshotCoversPrune, operationalReplaySet, preservedBySnapshotAnchor, rowsReturnedAfterOrphanCleanup, recoveryVerdict } from "./restart-boundary.js";
import { orderRestoredRows, RestoreIntegrityError, bindStoredEvidenceRoot } from "./block-body.js";

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
  zkmlProofsTable: typeof zkmlProofsTable;
}>>;

// ── Pool configuration ────────────────────────────────────────────────────────
// connectionTimeoutMillis: fail fast when Postgres is unreachable after a
//   restart instead of hanging indefinitely (default: 0 = wait forever).
// idleTimeoutMillis: release idle connections so a long-quiet node doesn't
//   accumulate stale sockets that break on the next query.
// max: keep the pool small — the chain is single-writer by design.
const POOL_CONFIG = {
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis:      30_000,
  max: 10,
};

// ── Retry helpers ─────────────────────────────────────────────────────────────

/** True for connection-level errors that are transient after a PG restart. */
function isRetryableError(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? "";
  const msg  = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    code === "ECONNRESET"   ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT"    ||
    code === "57P01"        || // admin_shutdown
    code === "57P02"        || // crash_shutdown
    code === "57P03"        || // cannot_connect_now (PG still starting)
    msg.includes("connection terminated") ||
    msg.includes("connection refused")    ||
    msg.includes("econnreset")
  );
}

/**
 * Run `fn` up to `maxAttempts` times, retrying with exponential backoff on
 * transient Postgres connection errors.  Non-retryable errors are re-thrown
 * immediately.  Exported so state.ts raw-pool callers can reuse the same logic.
 */
export async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableError(err) || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      logger.warn({ err, attempt, nextRetryMs: delay, label }, "Postgres transient error — retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Singleton pool shared by drizzle and getRawPool() ────────────────────────
// One pool object prevents double connection counts and ensures both callers
// benefit from the same error-event handler and config.

let _pool: InstanceType<typeof Pool> | null = null;
let _db: Db | null = null;
let _initDone = false;

function initPool(): InstanceType<typeof Pool> | null {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    _initDone = true;
    logger.info("DATABASE_URL not set — running in-memory mode (chain will not survive restarts)");
    return null;
  }
  try {
    const pool = new Pool({ connectionString: url, ...POOL_CONFIG });
    // Prevent unhandled-rejection crashes when an idle client encounters a
    // network error (e.g. Postgres restart).  pg-pool removes the broken
    // client from the pool automatically; the next query gets a fresh one.
    pool.on("error", (err) => {
      logger.error({ err }, "pg-pool idle client error — pool will reconnect on next query");
    });
    _pool = pool;
    _db = drizzle(pool, { schema: { blocksTable, transactionsTable, contractsTable, stateSnapshotsTable, zkmlProofsTable } });
    _initDone = true;
    logger.info({ url: url.replace(/:[^@]*@/, ":***@") }, "Postgres persistence enabled");
    return pool;
  } catch (err) {
    // Leave _initDone = false so the next call retries.
    logger.warn({ err }, "Failed to initialise Postgres pool — will retry on next access");
    return null;
  }
}

/** Lazy singleton — returns null when DATABASE_URL is absent.
 *  Does NOT cache null on failure so a transient startup race
 *  (Postgres not yet ready) is retried on the next call. */
function getDb(): Db | null {
  if (_initDone) return _db;
  initPool();
  return _db;
}

let _pressureColumn: Promise<void> | null = null;

/** Old databases predate the pressure column. The sealed hash binds it. */
async function ensureCommittedPressure(): Promise<void> {
  const pool = _pool;
  if (!pool) return;
  if (!_pressureColumn) {
    _pressureColumn = pool
      .query(`ALTER TABLE blocks
        ADD COLUMN IF NOT EXISTS committed_pressure double precision,
        ADD COLUMN IF NOT EXISTS chain_id integer,
        ADD COLUMN IF NOT EXISTS evidence_root text,
        ADD COLUMN IF NOT EXISTS omega_root text,
        ADD COLUMN IF NOT EXISTS evidence jsonb`)
      .then(() => pool.query(`DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'blocks' AND column_name = 'nonce' AND data_type = 'bigint'
          ) THEN
            ALTER TABLE blocks ALTER COLUMN nonce TYPE numeric(20,0);
          END IF;
        END $$`))
      .then(() => pool.query(`ALTER TABLE transactions
        ADD COLUMN IF NOT EXISTS public_key text,
        ADD COLUMN IF NOT EXISTS tx_index integer`))
      .then(() => undefined)
      .catch((err) => {
        _pressureColumn = null;
        throw err;
      });
  }
  await _pressureColumn;
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
    signature:   row.signature || undefined,
    publicKey:   row.publicKey ?? undefined,
  };
}

function transactionsInCommittedOrder(rows: Array<typeof transactionsTable.$inferSelect>): TxRecord[] {
  return orderRestoredRows(rows).map(toTxRecord);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * What a restart is allowed to do with a load.
 * Genesis is only an unconfigured process or a table a successful read
 * proved empty. Unreachable storage is not empty. An integrity failure
 * is not empty either.
 */
export type ChainLoad =
  | { kind: "unconfigured" }
  | { kind: "proved-empty" }
  | { kind: "restored"; blocks: BlockRecord[] }
  | { kind: "unreachable"; reason: string }
  | { kind: "integrity-failure"; reason: string };

export function startupFromLoad(load: ChainLoad):
  | { action: "genesis" }
  | { action: "restore"; blocks: BlockRecord[] }
  | { action: "refuse"; reason: string } {
  switch (load.kind) {
    case "unconfigured":
    case "proved-empty":
      return { action: "genesis" };
    case "restored":
      return { action: "restore", blocks: load.blocks };
    case "unreachable":
    case "integrity-failure":
      return { action: "refuse", reason: load.reason };
  }
}

function bindBlockEvidence<T extends { evidenceRoot?: string; evidence?: unknown; height: number }>(block: T): T {
  const bound = bindStoredEvidenceRoot(block.evidenceRoot, block.evidence);
  if (!bound.ok) {
    throw new RestoreIntegrityError(`${bound.reason} at height ${block.height}`);
  }
  block.evidenceRoot = bound.evidenceRoot;
  return block;
}

/**
 * Load persisted blocks for a restart.
 * `unconfigured` and `proved-empty` are the only loads that may become genesis.
 * Unreachable storage is its own result. A bad query, a chain with no unique
 * height-0 row, a retained fork, and an evidenceRoot column that is not the
 * evidence throw as integrity failures. None of those are an empty table.
 */
export async function loadBlocksFromDb(): Promise<ChainLoad> {
  const db = getDb();
  if (!db) return { kind: "unconfigured" };

  try {
    await ensureCommittedPressure();
    const [dbBlocks, dbTxs] = await Promise.all([
      db.select().from(blocksTable).orderBy(asc(blocksTable.height)),
      db.select().from(transactionsTable).where(eq(transactionsTable.status, "confirmed")),
    ]);

    if (dbBlocks.length === 0) return { kind: "proved-empty" };

    const canonicalRows = dbBlocks.filter((b) => b.evidence != null);
    const chainRows = dbBlocks.filter((b) => b.evidence == null);

    let splitLoad: typeof chainRows = [];
    if (chainRows.length > 0) {
      const selected = operationalReplaySet(chainRows);
      const verdict = recoveryVerdict({
        configured: true,
        queryFailed: false,
        operationalRows: chainRows.length,
        evidenceRows: canonicalRows.length,
        replay: selected.replay.length,
        retained: selected.retained.length,
      });
      if (verdict.verdict === "refused") {
        throw new RestoreIntegrityError(verdict.reason ?? "chain is not recoverable");
      }
      const snap = selected.orphans.length > 0 ? await loadLatestSnapshot() : null;
      const preserved = snap ? preservedBySnapshotAnchor(chainRows, snap.blockHash) : new Set<string>();
      const split = rowsReturnedAfterOrphanCleanup(selected, preserved);
      splitLoad = split.load;
      if (split.drop.length === 0) {
        if (selected.orphans.length > 0) {
          logger.info(
            { preserved: selected.orphans.length },
            "Disconnected rows are the snapshot suffix — not deleted",
          );
        }
      } else try {
        const db2 = getDb()!;
        const hashes = split.drop.map((row) => row.hash);
        await db2.transaction(async (tx) => {
          await tx.delete(transactionsTable).where(inArray(transactionsTable.blockHash, hashes));
          await tx.delete(blocksTable).where(inArray(blocksTable.hash, hashes));
        });
        logger.info({ deleted: hashes.length }, "Pruned operational rows that do not connect to genesis");
      } catch (pruneErr) {
        logger.warn({ pruneErr }, "Failed to prune disconnected operational rows (will retry)");
      }
      if (splitLoad.length === 0 && canonicalRows.length === 0) return { kind: "proved-empty" };
    }

    const validBlocks = [...splitLoad, ...canonicalRows];

    const rowsByBlock = new Map<string, typeof dbTxs>();
    for (const row of dbTxs) {
      if (!row.blockHash) continue;
      const list = rowsByBlock.get(row.blockHash) ?? [];
      list.push(row);
      rowsByBlock.set(row.blockHash, list);
    }
    const txsByBlock = new Map<string, TxRecord[]>();
    for (const [hash, rows] of rowsByBlock) {
      txsByBlock.set(hash, transactionsInCommittedOrder(rows));
    }

    return {
      kind: "restored",
      blocks: validBlocks.map((b) => bindBlockEvidence({
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
      committedPressure: b.committedPressure ?? undefined,
      chainId:       b.chainId ?? undefined,
      evidenceRoot:  b.evidenceRoot ?? undefined,
      omegaRoot:     b.omegaRoot ?? undefined,
      evidence:      (b.evidence as BlockRecord["evidence"]) ?? undefined,
    })),
    };
  } catch (err) {
    if (err instanceof RestoreIntegrityError) {
      return { kind: "integrity-failure", reason: err.message };
    }
    if (loadFailureIsUnreachable(err)) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, "Postgres unreachable — not a proved-empty chain");
      return { kind: "unreachable", reason };
    }
    const reason = err instanceof Error ? err.message : String(err);
    return {
      kind: "integrity-failure",
      reason: `chain load failed — not falling back to genesis: ${reason}`,
    };
  }
}

/** A connection that never answered. Not a SQL error, and not an empty table. */
export function loadFailureIsUnreachable(err: unknown): boolean {
  const text = errorText(err);
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|getaddrinfo|Connection terminated unexpectedly|the database system is (starting up|shutting down)/i.test(text);
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
    const cause = "cause" in err ? errorText((err as { cause?: unknown }).cause) : "";
    return `${err.name} ${code} ${err.message} ${cause}`;
  }
  return String(err);
}

export type PersistBlockOutcome = "inserted" | "identical" | "conflict" | "failed" | "absent";

export interface PersistBlockResult {
  /** True only when a matching row is confirmed in the database. */
  durable: boolean;
  outcome: PersistBlockOutcome;
}

/** In-memory state stays only for a confirmed row, or when no database is configured. */
export function persistKeepsMemory(result: PersistBlockResult): boolean {
  return result.outcome === "inserted" || result.outcome === "identical" || result.outcome === "absent";
}

type BlockRow = typeof blocksTable.$inferSelect;

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function sameJson(stored: unknown, incoming: unknown): boolean {
  return canonicalJson(stored ?? null) === canonicalJson(incoming ?? null);
}

function sameStoredBlock(row: BlockRow, block: BlockRecord): boolean {
  let nonce: bigint;
  try {
    nonce = asBlockNonce(block.nonce);
  } catch {
    return false;
  }
  let storedNonce: bigint;
  try {
    storedNonce = BigInt(row.nonce);
  } catch {
    return false;
  }
  const residualFp = block.residualFp ?? Math.floor(block.residual * 1e18);
  const storedFp = row.residualFp === null || row.residualFp === undefined ? null : Number(row.residualFp);
  return row.hash === block.hash
    && row.height === block.height
    && row.prevHash === block.prevHash
    && row.merkleRoot === block.merkleRoot
    && Number(row.timestamp) === block.timestamp
    && storedNonce === nonce
    && row.miner === block.miner
    && row.txCount === block.txCount
    && Number(row.coinbaseReward) === block.coinbaseReward
    && Boolean(row.finalized) === (block.finalized ?? false)
    && (row.stateRoot ?? null) === (block.stateRoot ?? null)
    && storedFp === residualFp
    && (row.committedPressure ?? null) === (block.committedPressure ?? null)
    && (row.chainId ?? null) === (block.chainId ?? null)
    && (row.evidenceRoot ?? null) === (block.evidenceRoot ?? null)
    && (row.omegaRoot ?? null) === (block.omegaRoot ?? null)
    && Number(row.difficulty) === block.difficulty
    && sameJson(row.zkProof, block.zkProof ?? null)
    && sameJson(row.evidence, block.evidence ?? null);
}

type TxRow = typeof transactionsTable.$inferSelect;

/** The stored transactions are the ones that were admitted, in that order. */
function sameStoredTxs(rows: TxRow[], block: BlockRecord): boolean {
  const ordered = [...rows].sort(
    (a, b) => (a.txIndex ?? 0) - (b.txIndex ?? 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0),
  );
  if (ordered.length !== block.transactions.length) return false;
  return block.transactions.every((tx, index) => {
    const row = ordered[index];
    if (!row) return false;
    return row.hash === tx.hash
      && row.from === tx.from
      && row.to === tx.to
      && Number(row.amount) === tx.amount
      && Number(row.fee) === tx.fee
      && Number(row.nonce) === tx.nonce
      && row.signature === (tx.signature ?? "")
      && (row.publicKey ?? null) === (tx.publicKey ?? null)
      && (row.txIndex ?? index) === index;
  });
}

type PersistTx = {
  insert: (table: typeof blocksTable | typeof transactionsTable) => {
    values: (values: unknown) => {
      onConflictDoNothing: () => {
        returning: (selection: unknown) => Promise<any[]>;
      };
    };
  };
  select: () => {
    from: (table: typeof blocksTable | typeof transactionsTable) => {
      where: (condition: unknown) => Promise<any[]>;
    };
  };
};

type PersistDb = {
  transaction: <T>(fn: (tx: PersistTx) => Promise<T>) => Promise<T>;
};

/**
 * Write one block and say what the database actually contains afterwards.
 * `inserted` and `identical` are confirmed matching rows.
 * `conflict` is a different row under the same hash. `failed` did not commit.
 * `absent` means there is no database — that is not durable storage.
 */
export async function persistBlockUsing(db: PersistDb | null, block: BlockRecord): Promise<PersistBlockResult> {
  if (!db) return { durable: false, outcome: "absent" };
  try {
    const outcome = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(blocksTable)
        .values({
          hash:           block.hash,
          height:         block.height,
          prevHash:       block.prevHash,
          merkleRoot:     block.merkleRoot,
          timestamp:      block.timestamp,
          nonce:          asBlockNonce(block.nonce),
          difficulty:     block.difficulty,
          residual:       block.residual,
          residualFp:     block.residualFp ?? Math.floor(block.residual * 1e18),
          miner:          block.miner,
          txCount:        block.txCount,
          coinbaseReward: block.coinbaseReward,
          finalized:      block.finalized ?? false,
          zkProof:        (block.zkProof ?? null) as unknown as null,
          stateRoot:      block.stateRoot ?? null,
          committedPressure: block.committedPressure ?? null,
          chainId:        block.chainId ?? null,
          evidenceRoot:   block.evidenceRoot ?? null,
          omegaRoot:      block.omegaRoot ?? null,
          evidence:       (block.evidence ?? null) as unknown as null,
        })
        .onConflictDoNothing()
        .returning({ hash: blocksTable.hash });

      const rows = await tx.select().from(blocksTable).where(eq(blocksTable.hash, block.hash));
      const row = rows[0];
      if (!row || !sameStoredBlock(row, block)) {
        throw new Error("persist conflict");
      }
      const storedTxs = await tx.select().from(transactionsTable).where(eq(transactionsTable.blockHash, block.hash));
      if (inserted.length === 0) {
        if (!sameStoredTxs(storedTxs, block)) throw new Error("persist conflict");
        return "identical" as const;
      }
      if (storedTxs.length !== 0) throw new Error("persist conflict");

      if (block.transactions.length > 0) {
        const written = await tx
          .insert(transactionsTable)
          .values(
            block.transactions.map((t, index) => ({
              hash:        t.hash,
              blockHash:   block.hash,
              blockHeight: block.height,
              from:        t.from,
              to:          t.to,
              amount:      t.amount,
              fee:         t.fee,
              nonce:       t.nonce,
              signature:   t.signature ?? "",
              publicKey:   t.publicKey ?? null,
              txIndex:     index,
              status:      "confirmed" as const,
              timestamp:   t.timestamp,
            })),
          )
          .onConflictDoNothing()
          .returning({ hash: transactionsTable.hash });
        if (written.length !== block.transactions.length) throw new Error("persist conflict");
      }
      return "inserted" as const;
    });
    return { durable: true, outcome };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    if (message === "persist conflict" || message.includes("persist conflict") || code === "23505") {
      return { durable: false, outcome: "conflict" };
    }
    if (isRetryableError(err)) throw err;
    logger.error({ err, height: block.height, hash: block.hash }, "persistBlock failed after retries — block data NOT persisted to DB");
    return { durable: false, outcome: "failed" };
  }
}

/**
 * Persist a single block and its confirmed transactions.
 * Does not throw. A caller that has already admitted the block must not
 * announce it unless persistKeepsMemory is true, and must not treat
 * `absent` as a durable write.
 */
export async function persistBlock(block: BlockRecord): Promise<PersistBlockResult> {
  const db = getDb();
  if (!db) return persistBlockUsing(null, block);
  try {
    await ensureCommittedPressure();
    return await withDbRetry("persistBlock", () => persistBlockUsing(db, block));
  } catch (err) {
    logger.error({ err, height: block.height, hash: block.hash }, "persistBlock failed after retries — block data NOT persisted to DB");
    return { durable: false, outcome: "failed" };
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

/** Drop the process-wide pool so this process can exit and a later one can connect. */
export async function closePersistence(): Promise<void> {
  const pool = _pool;
  _pool = null;
  _db = null;
  _initDone = false;
  if (pool) await pool.end();
}

/** True when a Postgres connection is available. */
export function isDbAvailable(): boolean {
  return getDb() !== null;
}

/**
 * Expose the shared pg.Pool for ChainState's raw SQL (DEX pools, SMT roots).
 * Returns the same pool instance used by drizzle — no second connection pool.
 */
export function getRawPool(): InstanceType<typeof Pool> | null {
  if (!_initDone) initPool();
  return _pool;
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
 * Write every contract from one call in a single transaction.
 * False means the transaction did not commit. No row from the batch is kept.
 */
export async function persistContractsAtomic(contracts: ContractRecord[]): Promise<boolean> {
  if (contracts.length === 0) return true;
  const db = getDb();
  if (!db) return true;
  try {
    await db.transaction(async (tx) => {
      for (const contract of contracts) {
        await tx
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
      }
    });
    return true;
  } catch (err) {
    logger.warn({ err, count: contracts.length }, "Contract batch did not commit");
    return false;
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
export interface SnapshotPartitions {
  pools: DexPool[];
  validators: ValidatorRecord[];
  stakes: StakeRecord[];
  difficulty: number;
  unbonding: UnbondingEntry[];
  contracts: ContractRecord[];
  /** Canonical Ω at this height. Absent on snapshots taken before the temporal membrane. */
  omega?: ReturnType<typeof omegaRecord>;
}

/** Stored inside the ledger JSONB so a restart does not need a new column. */
export const SNAPSHOT_PARTITIONS_KEY = "__partitions";

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
  /** Pools, validators, stake, and contracts. Absent on snapshots written before this field. */
  partitions?: SnapshotPartitions;
}

/**
 * Upsert a state snapshot for the given block height.
 * Returns false when Postgres is absent or the write fails. Callers that
 * prune must not treat a swallowed error as a durable snapshot.
 */
export async function saveStateSnapshot(data: StateSnapshotData): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    await db
      .insert(stateSnapshotsTable)
      .values({
        height:    data.height,
        blockHash: data.blockHash,
        stateRoot: data.stateRoot,
        ledger:    {
          ...data.ledger,
          ...(data.partitions ? { [SNAPSHOT_PARTITIONS_KEY]: data.partitions } : {}),
        } as StateSnapshotData["ledger"],
        utxos:     data.utxos,
        createdAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: stateSnapshotsTable.height,
        set: {
          blockHash: data.blockHash,
          stateRoot: data.stateRoot,
          ledger:    {
            ...data.ledger,
            ...(data.partitions ? { [SNAPSHOT_PARTITIONS_KEY]: data.partitions } : {}),
          } as StateSnapshotData["ledger"],
          utxos:     data.utxos,
          createdAt: Date.now(),
        },
      });
    logger.info({ height: data.height }, "State snapshot saved");
    return true;
  } catch (err) {
    logger.warn({ err, height: data.height }, "Failed to save state snapshot");
    return false;
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
    const raw = row.ledger as Record<string, unknown>;
    const partitions = (raw[SNAPSHOT_PARTITIONS_KEY] ?? undefined) as SnapshotPartitions | undefined;
    const ledger: StateSnapshotData["ledger"] = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === SNAPSHOT_PARTITIONS_KEY) continue;
      const acc = value as { balance?: number; nonce?: number };
      if (!acc || typeof acc.balance !== "number" || typeof acc.nonce !== "number") continue;
      ledger[key] = { balance: acc.balance, nonce: acc.nonce };
    }
    return {
      height:    row.height,
      blockHash: row.blockHash,
      stateRoot: row.stateRoot,
      ledger,
      utxos:     row.utxos  as StateSnapshotData["utxos"],
      partitions,
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
    await ensureCommittedPressure();
    const blockRows = await db
      .select()
      .from(blocksTable)
      .orderBy(asc(blocksTable.height), asc(blocksTable.hash));
    if (blockRows.length === 0) return null;

    const txRows = await db
      .select()
      .from(transactionsTable)
      .where(eq(transactionsTable.status, "confirmed"))
      .orderBy(asc(transactionsTable.blockHeight));

    const rowsByBlock = new Map<string, Array<typeof transactionsTable.$inferSelect>>();
    for (const row of txRows) {
      if (!row.blockHash) continue;
      const list = rowsByBlock.get(row.blockHash) ?? [];
      list.push(row);
      rowsByBlock.set(row.blockHash, list);
    }
    const txByBlock = new Map<string, TxRecord[]>();
    for (const [hash, rows] of rowsByBlock) {
      txByBlock.set(hash, transactionsInCommittedOrder(rows));
    }

    return blockRows.map((b) => bindBlockEvidence({
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
      chainId:       b.chainId ?? undefined,
      evidenceRoot:  b.evidenceRoot ?? undefined,
      omegaRoot:     b.omegaRoot ?? undefined,
      evidence:      (b.evidence as BlockRecord["evidence"]) ?? undefined,
      transactions:  txByBlock.get(b.hash) ?? [],
    }));
  } catch (err) {
    if (err instanceof RestoreIntegrityError) throw err;
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

type PruneTx = {
  delete: (table: typeof blocksTable | typeof transactionsTable) => {
    where: (condition: unknown) => Promise<unknown>;
  };
};

type PruneDb = {
  select: (selection: { hash: typeof blocksTable.hash }) => {
    from: (table: typeof blocksTable) => {
      where: (condition: unknown) => Promise<Array<{ hash: string }>>;
    };
  };
  transaction: <T>(fn: (tx: PruneTx) => Promise<T>) => Promise<T>;
};

/**
 * Delete block rows below `pruneBelow`, and the transaction rows that name them.
 * The declared schema has an index on block_hash, not a foreign key, so a
 * block delete does not remove those transactions.
 * Height 0 is not in this range. Returns how many block rows were selected.
 */
export async function deletePrunedBlockRows(db: PruneDb, pruneBelow: number): Promise<number> {
  const doomed = await db
    .select({ hash: blocksTable.hash })
    .from(blocksTable)
    .where(and(gte(blocksTable.height, 1), lt(blocksTable.height, pruneBelow)));
  const hashes = doomed.map((row) => row.hash);
  if (hashes.length === 0) return 0;
  await db.transaction(async (tx) => {
    await tx.delete(transactionsTable).where(inArray(transactionsTable.blockHash, hashes));
    await tx.delete(transactionsTable).where(and(
      gte(transactionsTable.blockHeight, 1),
      lt(transactionsTable.blockHeight, pruneBelow),
    ));
    await tx.delete(blocksTable).where(inArray(blocksTable.hash, hashes));
  });
  return hashes.length;
}

/**
 * Delete one abandoned branch by hash, and the transaction rows that name
 * those hashes. The replacement branch is not in this list. A snapshot anchor
 * must not be passed here. This does not choose between two children; the
 * caller already decided which hashes are no longer canonical.
 */
export async function deleteAbandonedBlockRows(db: PruneDb, hashes: readonly string[]): Promise<number> {
  const unique = [...new Set(hashes)].filter((hash) => hash.length > 0);
  if (unique.length === 0) return 0;
  await db.transaction(async (tx) => {
    await tx.delete(transactionsTable).where(inArray(transactionsTable.blockHash, unique));
    await tx.delete(blocksTable).where(inArray(blocksTable.hash, unique));
  });
  return unique.length;
}

/**
 * Prune blocks older than `keepBlocks` from Postgres.
 * Refuses (returns 0) unless the snapshot's own block row would survive the
 * delete. A snapshot one height below the cutoff does not cover it: that row
 * is deleted. ENABLE_UNSAFE_PRUNING bypasses a failed coverage check, not an
 * empty range.
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

    const snapRows = await db
      .select({ height: stateSnapshotsTable.height, blockHash: stateSnapshotsTable.blockHash })
      .from(stateSnapshotsTable)
      .orderBy(desc(stateSnapshotsTable.height))
      .limit(1);
    const snap = snapRows[0];

    let anchor: { hash: string; height: number } | null = null;
    if (snap) {
      const anchorRows = await db
        .select({ hash: blocksTable.hash, height: blocksTable.height })
        .from(blocksTable)
        .where(eq(blocksTable.hash, snap.blockHash))
        .limit(1);
      const row = anchorRows[0];
      if (row) anchor = { hash: row.hash, height: row.height };
    }

    const decision = snapshotCoversPrune({
      tipHeight,
      keepBlocks,
      snapshot: snap ? { height: snap.height, blockHash: snap.blockHash } : null,
      anchor,
    });
    if (!decision.allowed) {
      if (decision.reason === "nothing to prune") return 0;
      if (process.env["ENABLE_UNSAFE_PRUNING"] !== "true") {
        logger.warn(
          { pruneBelow: decision.pruneBelow, reason: decision.reason },
          "Block pruning skipped: the snapshot anchor would not survive",
        );
        return 0;
      }
      logger.warn(
        { pruneBelow: decision.pruneBelow, reason: decision.reason },
        "ENABLE_UNSAFE_PRUNING=true — pruning without a retained snapshot anchor (restart will lose state)",
      );
    }

    // Delete blocks with height in (0, pruneBelow) — never prune genesis (0).
    // transactions.block_hash is not a foreign key. The rows do not cascade.
    const count = await deletePrunedBlockRows(db, decision.pruneBelow);
    logger.info(
      { pruneBelow: decision.pruneBelow, tipHeight, keepBlocks, deleted: count },
      "Block pruning complete",
    );
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

// ── zkML proof persistence ────────────────────────────────────────────────────

export interface ZkmlProofData {
  modelId:      number;
  sealHex:      string;
  journalHex:   string;
  submittedAt:  number;
  modelRootHex?: string;
  inputHashHex?: string;
  blockHeight?:  number;
}

/**
 * Upsert a zkML proof receipt. Uses ON CONFLICT DO UPDATE so re-submitting
 * a proof for the same model overwrites the old record. Fire-and-forget safe.
 */
export async function persistZkmlProof(data: ZkmlProofData): Promise<void> {
  const db = getDb();
  if (!db) return;
  try {
    await db
      .insert(zkmlProofsTable)
      .values({
        modelId:      data.modelId,
        sealHex:      data.sealHex,
        journalHex:   data.journalHex,
        submittedAt:  data.submittedAt,
        modelRootHex: data.modelRootHex ?? null,
        inputHashHex: data.inputHashHex ?? null,
        blockHeight:  data.blockHeight ?? null,
      })
      .onConflictDoUpdate({
        target: zkmlProofsTable.modelId,
        set: {
          sealHex:      data.sealHex,
          journalHex:   data.journalHex,
          submittedAt:  data.submittedAt,
          modelRootHex: data.modelRootHex ?? null,
          inputHashHex: data.inputHashHex ?? null,
          blockHeight:  data.blockHeight ?? null,
        },
      });
  } catch (err) {
    logger.warn({ err, modelId: data.modelId }, "Failed to persist zkML proof — in-memory record still held");
  }
}

/**
 * Load a stored zkML proof receipt for a model from Postgres.
 * Returns null when unavailable (no DB, or no row for this modelId).
 */
export async function loadZkmlProof(modelId: number): Promise<ZkmlProofData | null> {
  const db = getDb();
  if (!db) return null;
  try {
    const rows = await db
      .select()
      .from(zkmlProofsTable)
      .where(eq(zkmlProofsTable.modelId, modelId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      modelId:      row.modelId,
      sealHex:      row.sealHex,
      journalHex:   row.journalHex,
      submittedAt:  row.submittedAt,
      modelRootHex: row.modelRootHex ?? undefined,
      inputHashHex: row.inputHashHex ?? undefined,
      blockHeight:  row.blockHeight ?? undefined,
    };
  } catch (err) {
    logger.warn({ err, modelId }, "Failed to load zkML proof from DB — falling back to in-memory");
    return null;
  }
}
