import { buildGenesisChain, mineNextBlock } from "./state.js";
import { addressFromSeed } from "./crypto.js";
import { logger } from "../lib/logger.js";

export const chainState = buildGenesisChain();

// Node's own mining address
export const minerAddress = addressFromSeed("equilibrium-node-rpc-miner");

// Auto-mine a new block every ~15 seconds
let miningInterval: ReturnType<typeof setInterval> | null = null;

export function startMining(): void {
  if (miningInterval) return;
  miningInterval = setInterval(() => {
    const block = mineNextBlock(chainState, minerAddress);
    logger.info({ height: block.height, hash: block.hash.slice(0, 16), txCount: block.txCount, residual: block.residual }, "Block mined");
    // Update peer heights
    for (const peer of chainState.peers) {
      if (peer.connected) peer.height = block.height;
    }
  }, 15_000);
  logger.info({ minerAddress }, "Mining started");
}

export function stopMining(): void {
  if (miningInterval) {
    clearInterval(miningInterval);
    miningInterval = null;
  }
}
