/**
 * A sealed header binds pressure, and a later process can recompute that hash
 * from the row. Run against a database that already has the blocks table.
 */
import { ChainState } from "../chain/state.js";
import { canonicalHeaderHash } from "../chain/crypto.js";
import { closePersistence, loadBlocksFromDb, persistBlock } from "../chain/persistence.js";
import type { BlockRecord } from "../chain/types.js";

const state = new ChainState();
const block: BlockRecord = {
  hash: "11".repeat(32),
  height: 0,
  // Not the genesis tip. This row seals pressure. It is not a successor.
  prevHash: "1".repeat(64),
  merkleRoot: "0".repeat(64),
  timestamp: 1_700_000_000,
  nonce: 7,
  difficulty: 1_000_000,
  residual: 0.0002011002025239986,
  recursionDepth: 2,
  coinbaseReward: 0,
  miner: "ab".repeat(20),
  txCount: 0,
  transactions: [],
  finalized: false,
  committedPressure: 0.25,
  sealIdentity: true,
};
state.addBlock(block);
if (!block.stateRoot) throw new Error("seal did not produce a state root");
await persistBlock(block);
await closePersistence();

const loaded = await loadBlocksFromDb();
const row = loaded?.[0];
if (!row?.stateRoot || row.residualFp === undefined) throw new Error("row did not round-trip");
const recomputed = canonicalHeaderHash({
  prevHash: row.prevHash,
  merkleRoot: row.merkleRoot,
  stateRoot: row.stateRoot,
  timestamp: row.timestamp,
  nonce: row.nonce,
  difficulty: row.difficulty,
  residualFp: row.residualFp,
  miner: row.miner,
  height: row.height,
  committedPressure: row.committedPressure ?? 0,
});
const zeroPressure = canonicalHeaderHash({
  prevHash: row.prevHash,
  merkleRoot: row.merkleRoot,
  stateRoot: row.stateRoot,
  timestamp: row.timestamp,
  nonce: row.nonce,
  difficulty: row.difficulty,
  residualFp: row.residualFp,
  miner: row.miner,
  height: row.height,
  committedPressure: 0,
});
console.log(JSON.stringify({
  ok: recomputed === block.hash && row.committedPressure === 0.25 && zeroPressure !== block.hash,
  stored: block.hash,
  recomputed,
  loadedPressure: row.committedPressure,
  zeroPressureDiffers: zeroPressure !== block.hash,
}));
await closePersistence();
