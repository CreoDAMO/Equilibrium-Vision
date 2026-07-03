import { buildGenesisChain, buildChainFromBlocks, mineNextBlock } from "./state.js";
import type { ChainState } from "./state.js";
import { addressFromSeed } from "./crypto.js";
import { logger } from "../lib/logger.js";
import { broadcast } from "../lib/ws-server.js";
import { loadBlocksFromDb, persistBlock, persistBlocks } from "./persistence.js";

// Node's own mining address
export const minerAddress = addressFromSeed("equilibrium-node-rpc-miner");

// chainState is assigned by initChain() before the server starts listening.
// Exported as `let` so tests and routes import a single stable reference.
export let chainState: ChainState;

// ── Async initialisation ──────────────────────────────────────────────────────

/**
 * Load chain from Postgres (if available) or build the 25-block genesis chain.
 * Must be awaited before the HTTP server starts.
 */
export async function initChain(): Promise<void> {
  const dbBlocks = await loadBlocksFromDb();

  if (dbBlocks) {
    logger.info({ blockCount: dbBlocks.length }, "Restoring chain from Postgres");
    chainState = buildChainFromBlocks(dbBlocks);
    logger.info({ height: chainState.height }, "Chain restored");
  } else {
    logger.info("Building genesis chain (in-memory or first boot)");
    chainState = buildGenesisChain();
    // Await genesis persist so the DB is fully consistent before mining starts.
    // If this fails (no DB configured) it is silently swallowed — the server
    // continues in pure in-memory mode.
    try {
      await persistBlocks(chainState.blocks);
      logger.info({ blockCount: chainState.blocks.length }, "Genesis blocks persisted");
    } catch (err) {
      logger.warn({ err }, "Genesis persistence failed — continuing in-memory");
    }
  }
}

// ── Stop-safe mining loop ────────────────────────────────────────────────────
//
// Uses setTimeout recursion + a generation counter instead of setInterval so
// that rapid stop→start sequences cannot produce duplicate concurrent cycles.
//
// Invariant: a scheduled or running cycle only reschedules itself when its
// captured `generation` still matches `miningGeneration` AND `miningEnabled`
// is true.  stopMining() bumps the generation so any in-flight cycle sees a
// stale generation and exits without rescheduling.

let miningEnabled    = false;
let miningGeneration = 0;
let miningTimer: ReturnType<typeof setTimeout> | null = null;

function runMiningCycle(generation: number): void {
  try {
    const block = mineNextBlock(chainState, minerAddress);
    logger.info(
      { height: block.height, hash: block.hash.slice(0, 16), txCount: block.txCount, residual: block.residual },
      "Block mined",
    );

    // Persist to Postgres (fire-and-forget — never blocks the mining loop)
    persistBlock(block).catch((err) =>
      logger.warn({ err, height: block.height }, "Block persistence failed"),
    );

    // Notify WebSocket clients of the new block
    broadcast({
      type: "new_block",
      data: {
        height:    block.height,
        hash:      block.hash,
        txCount:   block.txCount,
        residual:  block.residual,
        miner:     block.miner,
        timestamp: block.timestamp,
      },
    });

    // Update peer heights
    for (const peer of chainState.peers) {
      if (peer.connected) peer.height = block.height;
    }

    // Broadcast updated mempool size after the block clears transactions
    broadcast({
      type: "mempool_update",
      data: {
        size:     chainState.mempool.size,
        pressure: chainState.mempool.pressure,
      },
    });
  } finally {
    // Only reschedule if this cycle's generation is still current and mining
    // is still enabled.  Bumping miningGeneration in stopMining() makes any
    // in-flight finally block see a stale generation and exit cleanly.
    if (generation === miningGeneration && miningEnabled) {
      miningTimer = setTimeout(() => runMiningCycle(generation), 15_000);
    }
  }
}

export function startMining(): void {
  if (miningEnabled) return;
  miningEnabled = true;
  miningGeneration++;
  const gen = miningGeneration;
  logger.info({ minerAddress }, "Mining started");
  miningTimer = setTimeout(() => runMiningCycle(gen), 0);
}

export function stopMining(): void {
  miningEnabled = false;
  miningGeneration++;
  if (miningTimer) {
    clearTimeout(miningTimer);
    miningTimer = null;
  }
}
