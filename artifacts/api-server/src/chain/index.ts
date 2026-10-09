import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildGenesisChain, buildGenesisChainFromDoc, buildChainFromBlocks, buildDocChainFromBlocks, mineNextBlockAsync } from "./state.js";
import {
  persistContract, persistContractsAtomic, loadContractsFromDb,
  loadBlocksFromDb, persistBlock, persistBlocks,
  loadLatestSnapshot, saveStateSnapshot, loadAllBlocksRaw,
  pruneOldBlocks, DEFAULT_PRUNE_KEEP,
  getRawPool,
} from "./persistence.js";
import type { ChainState } from "./state.js";
import type { BlockRecord } from "./types.js";
import type { GenesisDocument } from "@workspace/coinomics";
import { addressFromSeed } from "./crypto.js";
import { canonicalCoinbase } from "@workspace/coinomics";
import { admitResidual, canonicalResidual } from "./canonical-residual.js";
import { foreignNonce } from "../../../../site/src/protocol/domain.js";
import { logger } from "../lib/logger.js";
import { broadcast } from "../lib/ws-server.js";
import { deployAdminMultisigIfConfigured } from "./multisig.js";
import { deployModelRegistryIfNeeded } from "./modelRegistry.js";
import { deployArbitrageIfNeeded } from "./arbitrage.js";
import { deployCrossChainRelayIfNeeded } from "./crossChainRelay.js";
import { p2pBridge } from "./p2p-bridge.js";
import { smtKey } from "./smt.js";
import { getVerifiedStateRoot } from "./state-root.js";
import { selectSnapshotAnchor, chainThroughAnchor, evidenceToReplay } from "./restart-boundary.js";

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
  // ── Snapshot fast-path ────────────────────────────────────────────────────
  // Try to restore from a state snapshot first.  A snapshot captures the full
  // ledger + UTXO set at a given height, so we only need to replay blocks
  // after that height through addBlock() — skipping potentially thousands of
  // full block replays on long-running chains.
  // ── Snapshot validation & fast-path ─────────────────────────────────────
  // A snapshot captures ledger + UTXO at a given height so we only replay
  // post-snapshot blocks.  Three conditions must ALL hold before we trust it;
  // any failure falls through to the full block-replay path below.
  //
  //   (a) Block rows are present
  //   (b) The row whose hash is snapshot.blockHash exists
  //   (c) That row's height is snapshot.height
  // Height is not unique, so the first row at the snapshot height is not the anchor.
  //
  // This guards against:
  //   • persistBlock failing after takeSnapshot succeeds (snapshot ahead of blocks)
  //   • Snapshot written to a different genesis/fork than what's in the DB
  //   • Partial writes or other DB inconsistencies
  const snapshot = await loadLatestSnapshot();
  let usedSnapshotPath = false;
  let evidenceReplay: import("./types.js").BlockRecord[] = [];

  if (snapshot) {
    logger.info(
      { snapshotHeight: snapshot.height, blockHash: snapshot.blockHash.slice(0, 16) },
      "State snapshot found — validating before use",
    );

    const allRaw = await loadAllBlocksRaw();

    // (a) Block rows must be present
    if (!allRaw || allRaw.length === 0) {
      logger.warn(
        { snapshotHeight: snapshot.height },
        "Snapshot exists but block table is empty — falling back to full replay",
      );
    } else {
      const anchor = selectSnapshotAnchor(allRaw, snapshot);
      if (!anchor.ok) {
        logger.warn(
          { snapshotHeight: snapshot.height, reason: anchor.reason },
          "Snapshot anchor is not the block with that hash — falling back to full replay",
        );
      } else {
        // ── All checks passed: use snapshot fast-path ─────────────────────
        usedSnapshotPath = true;

        const genesisDocForSnap = loadGenesisDoc();
        // Build a seeded-but-empty ChainState (validators, DEX, peers),
        // then overwrite ledger + UTXOs with the validated snapshot data.
        const seedState = genesisDocForSnap
          ? buildDocChainFromBlocks(genesisDocForSnap, [])
          : buildChainFromBlocks([]);

        if (genesisDocForSnap) {
          const firstV = genesisDocForSnap.initial_validators[0];
          if (firstV) {
            minerAddress = firstV.address;
            logger.info({ minerAddress }, "Mining as first genesis validator");
          }
        }

        if (snapshot.partitions) {
          seedState.importRestartSnapshot({
            ledger: snapshot.ledger,
            utxos: snapshot.utxos,
            ...snapshot.partitions,
          });
        } else {
          // Snapshots written before pools and validators were part of the root.
          seedState.ledger.restoreAccounts(snapshot.ledger);
          seedState.utxoSet.restoreFromSnapshot(snapshot.utxos);
        }

        // The anchor's parent walk, not whichever same-height row arrived first.
        const lineage = chainThroughAnchor(allRaw, anchor.block);
        for (const block of lineage) {
          seedState.blocks[block.height] = block;
          for (const tx of block.transactions) {
            const confirmed = { ...tx, blockHash: block.hash, blockHeight: block.height, status: "confirmed" as const };
            seedState.txIndex.set(tx.hash, confirmed);
            for (const addr of [tx.from, tx.to]) {
              if (!seedState.addressTxs.has(addr)) seedState.addressTxs.set(addr, new Set());
              seedState.addressTxs.get(addr)!.add(tx.hash);
            }
          }
        }

        // Difficulty after the snapshot block is what the next block reads.
        // That number is in the snapshot partitions. The block row stores the
        // difficulty the block was mined under, which is one adjustment behind.
        const tipEra = lineage[lineage.length - 1];
        if (!snapshot.partitions && tipEra) {
          seedState.currentDifficulty = tipEra.difficulty;
        }

        // ── Post-snapshot replay ──────────────────────────────────────────
        const later = allRaw
          .filter((block) => !block.evidence && block.height > snapshot.height)
          .sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
        for (const block of later) {
          try {
            seedState.addBlock(block);
          } catch (err) {
            if (!(err instanceof Error) || err.message !== "block is not the successor") throw err;
            seedState.recordUnexecuted(block);
          }
          for (const peer of seedState.peers) {
            if (peer.connected) peer.height = block.height;
          }
        }

        seedState.wasmVM.setBlockHeight(seedState.height);
        chainState = seedState;
        evidenceReplay = evidenceToReplay(allRaw, snapshot.height);
        logger.info(
          { height: chainState.height, snapshotHeight: snapshot.height, anchor: anchor.block.hash.slice(0, 16) },
          "Chain restored from validated snapshot + post-snapshot replay",
        );
      }
    }
  }

  if (!usedSnapshotPath) {
    // ── Full block replay ──────────────────────────────────────────────────
    const dbBlocks = await loadBlocksFromDb();

    if (dbBlocks) {
      logger.info({ blockCount: dbBlocks.length }, "Restoring chain from Postgres");
      const genesisDocForRestore = loadGenesisDoc();
      if (genesisDocForRestore) {
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
      evidenceReplay = evidenceToReplay(dbBlocks, null);
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
  }

  for (const block of evidenceReplay) {
    const err = await chainState.adoptReplay(block);
    if (err) logger.warn({ err, height: block.height, hash: block.hash }, "canonical evidence did not replay");
  }

  // ── Patch-05: DEX pool + SMT root persistence ─────────────────────────────
  // Inject a raw pg.Pool into ChainState so that swap / addLiquidity /
  // createPool persist their mutations and addBlock persists the SMT root.
  // No-op when DATABASE_URL is absent (in-memory mode unchanged).
  const rawPool = getRawPool();
  if (rawPool) {
    chainState.setDbPool(rawPool);
    logger.info("ChainState pool persistence enabled (DEX pools + SMT roots)");
  }

  // ── Smart contract boot ────────────────────────────────────────────────────
  // Wire the persist callback first so any contract deployed during replay
  // (future feature) is captured.
  chainState.wasmVM.setPersistCallback(persistContract);
  chainState.wasmVM.setCommitCallback(persistContractsAtomic);

  // Load previously deployed contracts from DB.
  const savedContracts = await loadContractsFromDb();
  if (savedContracts.length > 0) {
    chainState.wasmVM.loadContracts(savedContracts);
    logger.info({ count: savedContracts.length }, "Contracts loaded from DB");
  }

  // A restored snapshot is already the organism, including its contracts.
  // Deploying again would mint a contract the previous process did not have.
  if (!usedSnapshotPath) {
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
  // pattern as the admin multisig above.
  try {
    await deployModelRegistryIfNeeded(chainState.wasmVM, minerAddress);
    await deployArbitrageIfNeeded(chainState.wasmVM, minerAddress, minerAddress);
  } catch (err) {
    logger.warn({ err }, "ModelRegistry/Arbitrage deployment check failed — continuing without them");
  }

  // CrossChainRelay — deploy once on first boot; pin via CROSS_CHAIN_RELAY_ADDRESS.
  try {
    await deployCrossChainRelayIfNeeded(chainState.wasmVM, minerAddress);
  } catch (err) {
    logger.warn({ err }, "CrossChainRelay deployment check failed — continuing without it");
  }
  }

  // ── P2P inbound callbacks ──────────────────────────────────────────────────
  // Wire the sync-request and light-node-request handlers so that inbound
  // events from the p2p-sidecar are answered correctly.  The handlers are also
  // exercised by the p2p-sync integration test suite (sidecar not running —
  // tests invoke the callbacks directly).

  p2pBridge.onSyncRequest = async (requestId, _fromPeerId, kind, params) => {
    if (kind === "block") {
      const hashParam   = typeof params["hash"]   === "string" ? params["hash"]   : undefined;
      const heightParam = typeof params["height"] === "number" ? params["height"] : undefined;

      const block = hashParam !== undefined
        ? chainState.blocks.find((b) => b?.hash === hashParam)
        : heightParam !== undefined
          ? chainState.blocks[heightParam]
          : undefined;

      if (!block) {
        await p2pBridge.respondToSyncRequest(requestId, { error: "Block not found" });
      } else {
        await p2pBridge.respondToSyncRequest(requestId, block);
      }
      return;
    }

    if (kind === "headers") {
      const from  = typeof params["from"] === "number" ? Math.max(0, params["from"]) : 0;
      const tipH  = chainState.height;
      const to    = typeof params["to"]   === "number" ? Math.min(tipH, params["to"]) : tipH;
      const limit = Math.min(500, Math.max(0, to - from + 1));
      const headers: Record<string, unknown>[] = [];
      for (let h = from; h < from + limit; h++) {
        const b = chainState.blocks[h];
        if (b) {
          headers.push({
            hash:       b.hash,
            height:     b.height,
            prevHash:   b.prevHash,
            merkleRoot: b.merkleRoot,
            stateRoot:  b.stateRoot ?? "0".repeat(64),
            timestamp:  b.timestamp,
          });
        }
      }
      await p2pBridge.respondToSyncRequest(requestId, { headers });
      return;
    }

    await p2pBridge.respondToSyncRequest(requestId, { error: `Unknown sync kind: ${kind}` });
  };

  p2pBridge.onLightNodeRequest = async (requestId, _fromPeerId, query) => {
    const kind   = query.kind;
    const params = query.params ?? {};

    if (kind === "tip") {
      const tip = chainState.latestBlock;
      if (!tip) {
        await p2pBridge.respondToLightNodeRequest(requestId, { ok: false, error: "Chain not initialised" });
        return;
      }
      await p2pBridge.respondToLightNodeRequest(requestId, {
        ok: true,
        data: {
          height:    tip.height,
          hash:      tip.hash,
          prevHash:  tip.prevHash,
          stateRoot: tip.stateRoot ?? "0".repeat(64),
          timestamp: tip.timestamp,
        },
      });
      return;
    }

    if (kind === "headers") {
      const from  = typeof params["from"] === "number" ? Math.max(0, params["from"]) : 0;
      const tipH  = chainState.latestBlock?.height ?? 0;
      const to    = typeof params["to"]   === "number" ? Math.min(tipH, params["to"]) : tipH;
      const limit = Math.min(500, Math.max(0, to - from + 1));
      const headers: Record<string, unknown>[] = [];
      for (let h = from; h < from + limit; h++) {
        const b = chainState.blocks[h];
        if (b) {
          headers.push({
            hash:       b.hash,
            height:     b.height,
            prevHash:   b.prevHash,
            merkleRoot: b.merkleRoot,
            stateRoot:  b.stateRoot ?? "0".repeat(64),
            timestamp:  b.timestamp,
          });
        }
      }
      await p2pBridge.respondToLightNodeRequest(requestId, { ok: true, data: { headers } });
      return;
    }

    if (kind === "proof_account") {
      const address  = typeof params["address"] === "string" ? params["address"] : "";
      const verified = getVerifiedStateRoot(chainState);
      if (!verified.snapshot) {
        await p2pBridge.respondToLightNodeRequest(requestId, {
          ok:    false,
          error: verified.error?.message ?? "State root not available",
        });
        return;
      }
      const { tip, smt } = verified.snapshot;
      const acc          = chainState.ledger.getAccount(address);
      const key          = smtKey("acct", address);
      const compactProof = smt.proveCompact(key);
      await p2pBridge.respondToLightNodeRequest(requestId, {
        ok: true,
        data: { address, balance: acc.balance, nonce: acc.nonce, stateRoot: tip.stateRoot, height: tip.height, compactProof },
      });
      return;
    }

    // Unknown query kind — respond with ok=false so the caller can handle it
    await p2pBridge.respondToLightNodeRequest(requestId, {
      ok:    false,
      error: `Unknown query kind: ${kind}`,
    });
  };

  // ── onBlockBody: accept full block bodies gossiped from mobile miners ────────
  // After a phone submits a block via HTTP and gets an accepted response, it
  // gossips the full block body via the block-bodies topic.  This lets desktop
  // nodes (and other phones) add the block to their chain without needing a
  // separate sync RR request or direct HTTP submission.
  p2pBridge.onBlockBody = (body, _peerId) => {
    if (!chainState) return;

    const hash       = typeof body['hash']       === 'string' ? body['hash']       : '';
    const height     = typeof body['height']     === 'number' ? body['height']     : -1;
    const prevHash   = typeof body['prevHash']   === 'string' ? body['prevHash']   : '';
    let nonce: bigint;
    try {
      nonce = foreignNonce(body['nonce']);
    } catch (err) {
      logger.warn({ err, hash: hash.slice(0, 16) }, "p2p: nonce is not a u64");
      return;
    }
    const residual   = typeof body['residual']   === 'number' ? body['residual']   : 1;
    const timestamp  = typeof body['timestamp']  === 'number' ? body['timestamp']  : 0;
    const miner      = typeof body['miner']      === 'string' ? body['miner']      : '';
    const difficulty = typeof body['difficulty'] === 'number' ? body['difficulty'] : 1;

    if (!hash || height < 0 || !prevHash || !miner) return;
    if (chainState.blocks.some((b) => b?.hash === hash)) return;

    const merkle = typeof body["merkleRoot"] === "string" && /^[0-9a-f]{64}$/i.test(body["merkleRoot"])
      ? body["merkleRoot"]
      : "0".repeat(64);
    const canonicalDifficulty = chainState.canonicalBody.omega.difficulty;
    if (difficulty !== canonicalDifficulty) {
      logger.warn({ hash: hash.slice(0, 16), height, claimed: difficulty, canonical: canonicalDifficulty }, "p2p: difficulty is not the canonical difficulty");
      return;
    }
    const recomputed = canonicalResidual(
      { prevHash, merkleRoot: merkle, timestamp, nonce, difficulty: canonicalDifficulty },
      [],
      { cumulativeWork: height, mempoolPressure: 0 },
      chainState.canonicalBody.omega.couplings,
    );
    const admission = admitResidual(residual, recomputed, chainState.admissionTarget);
    if (!admission.ok) {
      logger.warn({ hash: hash.slice(0, 16), height, error: admission.error }, "p2p: gossip residual refused");
      return;
    }

    logger.info({ hash: hash.slice(0, 16), height }, "p2p: received block body via gossip");

    try {
      const block: BlockRecord = {
        hash,
        height,
        prevHash,
        merkleRoot:     merkle,
        timestamp,
        nonce,
        difficulty,
        residual:       admission.residual,
        residualFp:     Math.floor(admission.residual * 1e18),
        recursionDepth: 2,
        coinbaseReward: canonicalCoinbase(height, admission.residual, chainState.admissionTarget),
        miner,
        txCount:        0,
        transactions:   [],
      };
      chainState.addBlock(block);
      if (block.canonicalSuccessor !== true) {
        logger.warn({ hash: hash.slice(0, 16), height }, "p2p: block is not the successor");
        return;
      }
      void p2pBridge.gossipBlock(hash); // propagate to other desktop peers
      chainState.gossipBlock(hash);
      logger.info({ hash: hash.slice(0, 16), height }, 'p2p: block from gossip body accepted');
    } catch (err) {
      logger.warn({ err, hash: hash.slice(0, 16) }, 'p2p: block body from gossip rejected');
    }
  };
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

// ── Snapshot helpers ─────────────────────────────────────────────────────────

/** How often (in blocks) to automatically take a state snapshot. */
const SNAPSHOT_INTERVAL = 100;

/**
 * Capture the current ledger + UTXO state as a named snapshot at the tip.
 * Fire-and-forget safe — never throws.
 */
async function takeSnapshot(): Promise<boolean> {
  const tip = chainState?.latestBlock;
  if (!tip) return false;
  const snap = chainState.exportRestartSnapshot();
  return saveStateSnapshot({
    height:    tip.height,
    blockHash: tip.hash,
    stateRoot: tip.stateRoot ?? "",
    ledger:    snap.ledger,
    utxos:     snap.utxos,
    partitions: {
      pools: snap.pools,
      validators: snap.validators,
      stakes: snap.stakes,
      difficulty: snap.difficulty,
      unbonding: snap.unbonding,
      contracts: snap.contracts,
      omega: snap.omega as unknown as Record<string, unknown>,
    },
  });
}

/**
 * Save a snapshot of the current chain tip, then prune old blocks.
 * Pruning runs only after that write returns success. An older snapshot's
 * height is not treated as this write.
 */
export async function safelyPruneOldBlocks(keepBlocks = DEFAULT_PRUNE_KEEP): Promise<number> {
  const saved = await takeSnapshot();
  if (!saved) {
    logger.warn("Block pruning skipped: the snapshot write did not succeed");
    return 0;
  }
  return pruneOldBlocks(keepBlocks);
}

// ── Stop-safe mining loop ────────────────────────────────────────────────────

let miningEnabled    = false;
let miningGeneration = 0;
let miningTimer: ReturnType<typeof setTimeout> | null = null;

async function runMiningCycle(generation: number): Promise<void> {
  try {
    const block = await mineNextBlockAsync(chainState, minerAddress);
    if (block.canonicalSuccessor !== true) {
      logger.warn(
        { height: block.height, hash: block.hash.slice(0, 16) },
        "Mined block is not the successor — not persisted or announced",
      );
      return;
    }
    logger.info(
      { height: block.height, hash: block.hash.slice(0, 16), txCount: block.txCount, residual: block.residual },
      "Block mined",
    );

    // Persist to Postgres (fire-and-forget — never blocks the mining loop)
    persistBlock(block).catch((err) =>
      logger.warn({ err, height: block.height }, "Block persistence failed"),
    );

    // Take a state snapshot every SNAPSHOT_INTERVAL blocks so that pruning
    // and fast-path restarts are always possible without a full block replay.
    if (block.height % SNAPSHOT_INTERVAL === 0 && block.height > 0) {
      takeSnapshot().catch((err) =>
        logger.warn({ err, height: block.height }, "Periodic snapshot failed — continuing"),
      );
    }

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

    // Gossip the new block hash to the real P2P network (no-op if sidecar not running)
    void p2pBridge.gossipBlock(block.hash);
    // Update the internal gossip log for the explorer's network view
    chainState.gossipBlock(block.hash);

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
  } catch (err) {
    logger.warn({ err }, "Mining cycle refused the block — it was not announced");
  } finally {
    // Only reschedule if this cycle's generation is still current and mining
    // is still enabled.  Bumping miningGeneration in stopMining() makes any
    // in-flight finally block see a stale generation and exit cleanly.
    if (generation === miningGeneration && miningEnabled) {
      miningTimer = setTimeout(() => { void runMiningCycle(generation); }, 15_000);
    }
  }
}

export function startMining(): void {
  if (miningEnabled) return;
  miningEnabled = true;
  miningGeneration++;
  const gen = miningGeneration;
  logger.info({ minerAddress }, "Mining started");
  miningTimer = setTimeout(() => { void runMiningCycle(gen); }, 0);
}

export function stopMining(): void {
  miningEnabled = false;
  miningGeneration++;
  if (miningTimer) {
    clearTimeout(miningTimer);
    miningTimer = null;
  }
}
