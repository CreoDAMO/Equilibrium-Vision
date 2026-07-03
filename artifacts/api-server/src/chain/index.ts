import { buildGenesisChain, mineNextBlock } from "./state.js";
import { addressFromSeed } from "./crypto.js";
import { logger } from "../lib/logger.js";
import { broadcast } from "../lib/ws-server.js";

export const chainState = buildGenesisChain();

// Node's own mining address
export const minerAddress = addressFromSeed("equilibrium-node-rpc-miner");

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
  // Kick off first cycle immediately; subsequent cycles are scheduled in finally
  miningTimer = setTimeout(() => runMiningCycle(gen), 0);
}

export function stopMining(): void {
  miningEnabled = false;
  miningGeneration++; // invalidates any in-flight cycle's generation token
  if (miningTimer) {
    clearTimeout(miningTimer);
    miningTimer = null;
  }
}
