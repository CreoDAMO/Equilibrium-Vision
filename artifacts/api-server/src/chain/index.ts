import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildGenesisChain, buildGenesisChainFromDoc, buildChainFromBlocks, buildDocChainFromBlocks, mineNextBlock } from "./state.js";
import { persistContract, loadContractsFromDb } from "./persistence.js";
import type { ChainState } from "./state.js";
import type { GenesisDocument } from "@workspace/coinomics";
import { addressFromSeed } from "./crypto.js";
import { logger } from "../lib/logger.js";
import { broadcast } from "../lib/ws-server.js";
import { loadBlocksFromDb, persistBlock, persistBlocks } from "./persistence.js";
import { deployAdminMultisigIfConfigured } from "./multisig.js";
import { deployModelRegistryIfNeeded } from "./modelRegistry.js";
import { deployArbitrageIfNeeded } from "./arbitrage.js";
import { deployCrossChainRelayIfNeeded } from "./crossChainRelay.js";

// Node's own mining address. Defaults to the "equilibrium-miner-1" dev seed
// address, but overridden by initChain() to the first genesis.json validator
// when a genesis doc is present — so live block production credits a
// registered validator and fee earnings appear in the Explorer.
export let minerAddress = addressFromSeed("equilibrium-miner-1");

// chainState is assigned by initChain() before the server starts listening.
// Exported as `let` so tests and routes import a single stable reference.
export let chainState: ChainState;

// ── Async initialisation ──────────────────────────────────────────────────────

/**
 * Load chain from Postgres (if available) or build the 25-block genesis chain.
 * Must be awaited before the HTTP server starts.
 */
/**
 * Candidate paths for genesis.json (checked in order):
 *  1. GENESIS_PATH env var — explicit override, useful for deployment.
 *  2. Two levels up from process.cwd() — covers the case where pnpm runs
 *     in artifacts/api-server/ and genesis.json is at the workspace root.
 *  3. process.cwd() itself — covers the case where the server is run from
 *     the workspace root directly.
 */
function findGenesisPath(): string | null {
  const candidates = [
    process.env["GENESIS_PATH"],
    resolve(process.cwd(), "..", "..", "genesis.json"),
    resolve(process.cwd(), "genesis.json"),
  ].filter(Boolean) as string[];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Basic runtime validation of a raw genesis doc (throws on violation). */
function validateGenesisDoc(doc: GenesisDocument): void {
  if (!doc.chain_id?.trim()) throw new Error("genesis.json: missing chain_id");
  if (!doc.timestamp || Number.isNaN(Date.parse(doc.timestamp)))
    throw new Error(`genesis.json: invalid timestamp: ${doc.timestamp}`);
  const supply = Number(doc.initial_supply);
  if (!Number.isFinite(supply) || supply <= 0)
    throw new Error(`genesis.json: invalid initial_supply: ${doc.initial_supply}`);
  if (!Array.isArray(doc.allocations) || doc.allocations.length === 0)
    throw new Error("genesis.json: allocations must be a non-empty array");
  const allocSum = doc.allocations.reduce((s, a) => {
    const amt = Number(a.amount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error(`genesis.json: invalid allocation amount "${a.amount}"`);
    if (!a.address?.trim()) throw new Error(`genesis.json: allocation missing address`);
    return s + amt;
  }, 0);
  // Validator bondedStake at genesis is implicit — it is not a ledger allocation
  // but it counts toward total supply.  Allow: allocations + validatorStake === initial_supply.
  const validatorStakeSum = Array.isArray(doc.initial_validators)
    ? doc.initial_validators.reduce((s, v) => s + Number(v.stake), 0)
    : 0;
  const accountedFor = allocSum + validatorStakeSum;
  if (Math.abs(accountedFor - supply) > 1e-6)
    throw new Error(
      `genesis.json: allocations (${allocSum}) + validator stake (${validatorStakeSum}) = ${accountedFor} ≠ initial_supply (${supply})`,
    );
  if (!Array.isArray(doc.initial_validators) || doc.initial_validators.length === 0)
    throw new Error("genesis.json: initial_validators must be non-empty");
  for (const v of doc.initial_validators) {
    if (!v.address?.trim()) throw new Error(`genesis.json: validator missing address`);
    const stake = Number(v.stake);
    if (!Number.isFinite(stake) || stake <= 0)
      throw new Error(`genesis.json: validator "${v.name}" has invalid stake "${v.stake}"`);
  }
}

/** Load and validate genesis.json, returning null if absent or invalid. */
function loadGenesisDoc(): GenesisDocument | null {
  const genesisPath = findGenesisPath();
  if (!genesisPath) return null;
  try {
    const raw = readFileSync(genesisPath, "utf-8");
    const doc = JSON.parse(raw) as GenesisDocument;
    validateGenesisDoc(doc);
    logger.info({ path: genesisPath, chainId: doc.chain_id }, "Loaded genesis.json");
    return doc;
  } catch (err) {
    logger.warn({ err }, "Failed to load genesis.json — falling back to dev genesis");
    return null;
  }
}

export async function initChain(): Promise<void> {
  const dbBlocks = await loadBlocksFromDb();

  if (dbBlocks) {
    logger.info({ blockCount: dbBlocks.length }, "Restoring chain from Postgres");
    // Use doc-aware restoration if genesis.json is present so validator/pool
    // state matches the original genesis document rather than dev seed data.
    const genesisDocForRestore = loadGenesisDoc();
    if (genesisDocForRestore) {
      // Use the first genesis validator as the local miner so that blocks
      // produced by this node are attributed to a registered validator and
      // the Fee Earnings tab in the Explorer shows real data.
      const firstGenesisValidator = genesisDocForRestore.initial_validators[0];
      if (firstGenesisValidator) {
        minerAddress = firstGenesisValidator.address;
        logger.info({ minerAddress }, "Mining as first genesis validator");
      }
      chainState = buildDocChainFromBlocks(genesisDocForRestore, dbBlocks);
      logger.info({ height: chainState.height, chainId: genesisDocForRestore.chain_id }, "Chain restored from doc genesis");
    } else {
      chainState = buildChainFromBlocks(dbBlocks);
    }
    logger.info({ height: chainState.height }, "Chain restored");
  } else {
    const genesisDoc = loadGenesisDoc();
    if (genesisDoc) {
      logger.info({ chainId: genesisDoc.chain_id }, "Building genesis chain from genesis.json");
      const firstGenesisValidator = genesisDoc.initial_validators[0];
      if (firstGenesisValidator) {
        minerAddress = firstGenesisValidator.address;
        logger.info({ minerAddress }, "Mining as first genesis validator");
      }
      chainState = buildGenesisChainFromDoc(genesisDoc);
    } else {
      logger.info("Building dev genesis chain (no genesis.json found)");
      chainState = buildGenesisChain();
    }
    // Persist genesis blocks so subsequent restarts load from DB.
    try {
      await persistBlocks(chainState.blocks);
      logger.info({ blockCount: chainState.blocks.length }, "Genesis blocks persisted");
    } catch (err) {
      logger.warn({ err }, "Genesis persistence failed — continuing in-memory");
    }
  }

  // ── Smart contract boot ────────────────────────────────────────────────────
  // Wire the persist callback first so any contract deployed during replay
  // (future feature) is captured.
  chainState.wasmVM.setPersistCallback(persistContract);

  // Load previously deployed contracts from DB.
  const savedContracts = await loadContractsFromDb();
  if (savedContracts.length > 0) {
    chainState.wasmVM.loadContracts(savedContracts);
    logger.info({ count: savedContracts.length }, "Contracts loaded from DB");
  }

  // Admin multisig — replaces the single ADMIN_KEY secret for privileged
  // actions (validator slashing) with an on-chain, threshold-signed gate.
  // No-op unless ADMIN_MULTISIG_OWNERS (fresh deploy) or ADMIN_MULTISIG_ADDRESS
  // (existing contract) is configured.
  try {
    await deployAdminMultisigIfConfigured(chainState.wasmVM, minerAddress);
  } catch (err) {
    logger.warn({ err }, "Admin multisig deployment check failed — continuing without it");
  }

  // ModelRegistry + Arbitrage — same "deploy once, then pin via env var"
  // pattern as the admin multisig above. Arbitrage's model is deliberately
  // NOT auto-configured here: setArbitrageModel(registry, modelId) needs a
  // real modelId, and no model exists yet at genesis boot. An admin wires
  // them together later via POST /api/arbitrage/set-model once a model has
  // been proposed (and, for execute() to succeed, verified) in ModelRegistry.
  try {
    await deployModelRegistryIfNeeded(chainState.wasmVM, minerAddress);
    await deployArbitrageIfNeeded(chainState.wasmVM, minerAddress, minerAddress);
  } catch (err) {
    logger.warn({ err }, "ModelRegistry/Arbitrage deployment check failed — continuing without them");
  }

  // CrossChainRelay — deploy once on first boot; pin via CROSS_CHAIN_RELAY_ADDRESS.
  // Gracefully skipped if the contract hex hasn't been built yet.
  try {
    await deployCrossChainRelayIfNeeded(chainState.wasmVM, minerAddress);
  } catch (err) {
    logger.warn({ err }, "CrossChainRelay deployment check failed — continuing without it");
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
