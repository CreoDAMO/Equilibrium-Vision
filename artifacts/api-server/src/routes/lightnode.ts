/**
 * lightnode.ts — Mobile light-node API
 *
 * Exposes a minimal set of endpoints a phone can use to participate in the
 * Equilibrium network without downloading the full chain:
 *
 *   GET /lightnode/tip              — current chain tip + state root
 *   GET /lightnode/headers          — headers-only sync (?from=N&to=M)
 *   GET /lightnode/sync             — incremental sync (?after=N&limit=L)
 *   GET /lightnode/proof/account/:address — SMT proof for an account
 *   GET /lightnode/proof/utxo/:txHash/:index — SMT proof for a UTXO
 *   GET /lightnode/chain-params     — network parameters + genesis info
 *   GET /lightnode/peers            — peer list for mobile P2P bootstrap
 *
 * Protocol guarantees:
 *   - Every response includes the current `stateRoot` so the client can
 *     verify proofs without a separate round-trip.
 *   - Headers contain only fields needed for fork-choice (no tx data).
 *   - Proofs are 256-sibling SMT proofs verifiable offline.
 */

import { Router } from "express";
import { chainState } from "../chain/index.js";
import { SparseMerkleTree, smtKey, smtValue } from "../chain/smt.js";
import type { BlockRecord, LightBlockHeader } from "../chain/types.js";

const router = Router();

// ── Helper: compact header from full block record ─────────────────────────────

function toLightHeader(b: BlockRecord): LightBlockHeader {
  return {
    hash:           b.hash,
    height:         b.height,
    prevHash:       b.prevHash,
    merkleRoot:     b.merkleRoot,
    stateRoot:      b.stateRoot ?? "0".repeat(64),
    timestamp:      b.timestamp,
    nonce:          b.nonce,
    difficulty:     b.difficulty,
    residual:       b.residual,
    residualFp:     b.residualFp ?? Math.floor(b.residual * 1e18),
    recursionDepth: b.recursionDepth,
    coinbaseReward: b.coinbaseReward,
    miner:          b.miner,
    txCount:        b.txCount,
    finalized:      b.finalized ?? false,
  };
}

// ── Helper: rebuild SMT from current chain state ──────────────────────────────
//
// Reuses the cached SMT from the last block if available. Rebuilds from
// scratch otherwise (e.g. after a restart before any new block is mined).

function getCurrentSmt(): SparseMerkleTree {
  // Use the cached SMT from the most recent addBlock() call if available
  if (chainState._stateSmt) return chainState._stateSmt;

  // Rebuild from scratch
  const smt = new SparseMerkleTree();
  for (const [addr, acc] of chainState.ledger.getAllAccounts()) {
    smt.set(smtKey("acct", addr), smtValue(`${acc.balance}:${acc.nonce}`));
  }
  for (const utxo of chainState.utxoSet.getAllUnspent()) {
    smt.set(
      smtKey("utxo", `${utxo.txHash}:${utxo.outputIndex}`),
      smtValue(`${utxo.amount}:${utxo.address}:${utxo.blockHeight}`),
    );
  }
  for (const contract of chainState.wasmVM.listContracts()) {
    smt.set(
      smtKey("contract", contract.address),
      smtValue(JSON.stringify(contract.storage)),
    );
  }
  chainState._stateSmt = smt;
  return smt;
}

// ── GET /lightnode/tip ────────────────────────────────────────────────────────

router.get("/lightnode/tip", (_req, res) => {
  const tip = chainState.latestBlock;
  if (!tip) {
    res.status(503).json({ error: "Chain not initialised" });
    return;
  }
  res.json({
    height:        tip.height,
    hash:          tip.hash,
    prevHash:      tip.prevHash,
    stateRoot:     tip.stateRoot ?? "0".repeat(64),
    merkleRoot:    tip.merkleRoot,
    timestamp:     tip.timestamp,
    difficulty:    tip.difficulty,
    residual:      tip.residual,
    residualFp:    tip.residualFp ?? Math.floor(tip.residual * 1e18),
    finalized:     tip.finalized ?? false,
    finalizedHeight: chainState.finalizedHeight,
    peers:         chainState.peers.filter((p) => p.connected).length,
    /** Protocol hint: how many siblings in each SMT proof */
    smtDepth:      256,
  });
});

// ── GET /lightnode/headers?from=N&to=M ────────────────────────────────────────

router.get("/lightnode/headers", (req, res) => {
  const tip = chainState.latestBlock;
  if (!tip) { res.status(503).json({ error: "Chain not initialised" }); return; }

  const from  = Math.max(0, parseInt(String(req.query["from"]  ?? 0), 10));
  const to    = Math.min(tip.height, parseInt(String(req.query["to"]   ?? tip.height), 10));
  const limit = Math.min(500, to - from + 1); // cap at 500 headers per request

  if (isNaN(from) || isNaN(to) || from > to) {
    res.status(400).json({ error: "Invalid range: from must be ≤ to" });
    return;
  }

  const headers: LightBlockHeader[] = [];
  for (let h = from; h < from + limit; h++) {
    const b = chainState.blocks[h];
    if (b) headers.push(toLightHeader(b));
  }

  res.json({
    from,
    to:    from + headers.length - 1,
    count: headers.length,
    tip:   tip.height,
    headers,
  });
});

// ── GET /lightnode/sync?after=N&limit=L ──────────────────────────────────────
//
// Mobile-optimised incremental sync. Returns up to `limit` headers after
// `after` height. The client polls this repeatedly, advancing `after` by
// the returned `count` each time, until `tip` === its current height.

router.get("/lightnode/sync", (req, res) => {
  const tip = chainState.latestBlock;
  if (!tip) { res.status(503).json({ error: "Chain not initialised" }); return; }

  const after = parseInt(String(req.query["after"] ?? -1), 10);
  const limit = Math.min(200, parseInt(String(req.query["limit"] ?? 100), 10));

  if (isNaN(after)) {
    res.status(400).json({ error: "after must be an integer" });
    return;
  }

  const headers: LightBlockHeader[] = [];
  for (
    let h = Math.max(0, after + 1);
    h <= tip.height && headers.length < limit;
    h++
  ) {
    const b = chainState.blocks[h];
    if (b) headers.push(toLightHeader(b));
  }

  res.json({
    syncedTo: after,
    tip:      tip.height,
    count:    headers.length,
    more:     (after + headers.length) < tip.height,
    headers,
  });
});

// ── GET /lightnode/proof/account/:address ─────────────────────────────────────
//
// Returns the account's current balance+nonce plus a 256-sibling SMT proof
// against the current tip's stateRoot. A mobile client can verify this
// offline with SparseMerkleTree.verify() against the stateRoot from /tip.

router.get("/lightnode/proof/account/:address", (req, res) => {
  const { address } = req.params;
  const tip = chainState.latestBlock;
  if (!tip) { res.status(503).json({ error: "Chain not initialised" }); return; }

  const acc   = chainState.ledger.getAccount(address);
  const smt   = getCurrentSmt();
  const key   = smtKey("acct", address);
  const proof = smt.prove(key);

  res.json({
    address,
    balance:    acc.balance,
    nonce:      acc.nonce,
    stateRoot:  tip.stateRoot ?? smt.root(),
    height:     tip.height,
    proof: {
      key:      proof.key,
      value:    proof.value,
      siblings: proof.siblings,
      root:     proof.root,
    },
    /** The value encoding for verification: SHA256("balance:nonce") */
    valueEncoding: "sha256(balance.toString() + ':' + nonce.toString())",
  });
});

// ── GET /lightnode/proof/utxo/:txHash/:index ──────────────────────────────────

router.get("/lightnode/proof/utxo/:txHash/:index", (req, res) => {
  const { txHash, index } = req.params;
  const outputIndex = parseInt(index, 10);
  const tip = chainState.latestBlock;

  if (!tip) { res.status(503).json({ error: "Chain not initialised" }); return; }
  if (isNaN(outputIndex)) { res.status(400).json({ error: "index must be an integer" }); return; }

  const utxo  = chainState.utxoSet.get(txHash, outputIndex);
  const smt   = getCurrentSmt();
  const key   = smtKey("utxo", `${txHash}:${outputIndex}`);
  const proof = smt.prove(key);

  res.json({
    txHash,
    outputIndex,
    utxo:       utxo ?? null,
    stateRoot:  tip.stateRoot ?? smt.root(),
    height:     tip.height,
    proof: {
      key:      proof.key,
      value:    proof.value,
      siblings: proof.siblings,
      root:     proof.root,
    },
    valueEncoding: "sha256(amount.toString() + ':' + address + ':' + blockHeight.toString())",
  });
});

// ── GET /lightnode/chain-params ───────────────────────────────────────────────

router.get("/lightnode/chain-params", (_req, res) => {
  const tip = chainState.latestBlock;
  res.json({
    chainId:         "equilibrium-1",
    height:          tip?.height ?? 0,
    stateRoot:       tip?.stateRoot ?? "0".repeat(64),
    difficulty:      chainState.currentDifficulty,
    finalizedHeight: chainState.finalizedHeight,
    validatorCount:  chainState.validators.size,
    mempoolSize:     chainState.mempool.size,
    dexPoolCount:    chainState.dexPools.size,
    contractCount:   chainState.wasmVM.contractCount(),
    smtDepth:        256,
    residualScale:   1e18,
    /** Mobile node can prune blocks older than this height safely */
    pruneBelow:      Math.max(0, (tip?.height ?? 0) - 10_000),
  });
});

// ── GET /lightnode/peers ──────────────────────────────────────────────────────

router.get("/lightnode/peers", (_req, res) => {
  res.json({
    peers: chainState.peers.map((p) => ({
      peerId:    p.peerId,
      address:   p.address,
      height:    p.height,
      connected: p.connected,
      syncState: p.syncState ?? "synced",
      latencyMs: p.latencyMs,
    })),
    count: chainState.peers.length,
  });
});

export default router;
