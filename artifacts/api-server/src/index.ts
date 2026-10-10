import http from "node:http";
import app from "./app.js";
import { logger } from "./lib/logger.js";
import { initChain, startMining, chainState } from "./chain/index.js";
import { createWsServer } from "./lib/ws-server.js";
import { StratumServer } from "./lib/stratum-server.js";
import { closeWorkers, warmupConsensus } from "./variational-ai/bridge.js";
import { p2pBridge } from "./chain/p2p-bridge.js";
import { epidemicBroadcaster } from "./chain/epidemic.js";
import { contributionTracker } from "./chain/contribution.js";
import { smtKey } from "./chain/smt.js";
import { getVerifiedStateRoot } from "./chain/state-root.js";
import { admitResidual, canonicalResidual, pressureEvidence } from "./chain/canonical-residual.js";
import { foreignNonce } from "../../../site/src/protocol/domain.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Initialise chain (load from Postgres or build genesis), then start the server.
(async () => {
  await initChain();

  // Wrap Express in a plain HTTP server so we can attach the WebSocket upgrade
  const server = http.createServer(app);
  createWsServer(server);

  server.listen(port, () => {
    logger.info({ port }, "Server listening");
    startMining();

    // Start the real libp2p P2P sidecar (no-op if binary not yet compiled)
    p2pBridge.start();

    // ── Epidemic TX broadcaster ─────────────────────────────────────────────
    // Store-and-forward: when peers reconnect, flush pending TXs to them.
    epidemicBroadcaster.start(
      (txHash) => p2pBridge.gossipTx(txHash),
    );

    // ── P2P Bridge event wiring ─────────────────────────────────────────────
    p2pBridge.onPeer = (event, peerId) => {
      if (event === 'connected') {
        contributionTracker.onPeerConnected(peerId);
        void epidemicBroadcaster.onPeerConnected(peerId);
      } else {
        contributionTracker.onPeerDisconnected(peerId);
      }
    };

    // Maximum residual a PoS block may have — must match routes/blocks.ts
    p2pBridge.onBlock = (blockHash, peerId) => {
      contributionTracker.onBlockRelayed(peerId);
      // Update the local gossip log so the Explorer network view reflects P2P activity
      if (chainState) chainState.gossipBlock(blockHash);

      // If we haven't seen this block body yet, fetch it from the announcing peer
      // via the /equilibrium/sync/1.0.0 RR protocol — no HTTP required.
      if (chainState && !chainState.getBlockByHash(blockHash)) {
        p2pBridge.requestSync(peerId, 'block', { hash: blockHash })
          .then(async (res) => {
            if (!res.ok || !res.data) {
              logger.debug({ blockHash, peerId, err: res.error }, 'P2P body sync: peer could not serve block');
              return;
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const remote = res.data as any;

            let remoteNonce: bigint;
            try {
              remoteNonce = foreignNonce(remote.nonce);
            } catch (err) {
              logger.warn({ err, blockHash, peerId }, "P2P sync: nonce is not a u64");
              return;
            }
            remote.nonce = remoteNonce;

            if (remote.evidence && chainState) {
              const err = await chainState.adoptReplay({
                hash: typeof remote.hash === "string" ? remote.hash : blockHash,
                height: Number(remote.height) || 0,
                prevHash: typeof remote.prevHash === "string" ? remote.prevHash : "",
                merkleRoot: typeof remote.merkleRoot === "string" ? remote.merkleRoot : "0".repeat(64),
                timestamp: Number(remote.timestamp) || 0,
                nonce: remoteNonce,
                difficulty: Number(remote.difficulty) || 0,
                residual: Number(remote.residual) || 0,
                residualFp: typeof remote.residualFp === "number" ? remote.residualFp : undefined,
                recursionDepth: 2,
                coinbaseReward: Number(remote.coinbaseReward) || 0,
                miner: String(remote.miner ?? ""),
                txCount: 0,
                transactions: [],
                committedPressure: typeof remote.committedPressure === "number" ? remote.committedPressure : 0,
                stateRoot: typeof remote.stateRoot === "string" ? remote.stateRoot : undefined,
                chainId: typeof remote.chainId === "number" ? remote.chainId : undefined,
                evidenceRoot: typeof remote.evidenceRoot === "string" ? remote.evidenceRoot : undefined,
                omegaRoot: typeof remote.omegaRoot === "string" ? remote.omegaRoot : undefined,
                evidence: remote.evidence,
              });
              if (err) {
                logger.warn({ err, blockHash, peerId }, "P2P sync: canonical evidence refused");
                return;
              }
              const { persistBlock } = await import("./chain/persistence.js");
              persistBlock({ ...remote, hash: typeof remote.hash === "string" ? remote.hash : blockHash }).catch((persistErr: unknown) =>
                logger.warn({ err: persistErr, blockHash }, "P2P sync: canonical evidence persistence failed"),
              );
              return;
            }

            // ── Validate the received block before insertion ───────────────────
            // Re-check: another path may have added this block while we were fetching
            if (chainState.getBlockByHash(blockHash)) return;

            const remoteHeight: number  = Number(remote.height);
            const remoteResidual: number = Number(remote.residual);

            // Only accept the immediate next block to avoid complex reorg logic.
            // Fork-choice across heights is deferred to the full sync protocol.
            const work = chainState.canonicalWork();
            if (remoteHeight !== work.height) {
              logger.debug(
                { blockHash, remoteHeight, ourHeight: work.height - 1 },
                'P2P sync: block is not the next height — skipping',
              );
              return;
            }

            // Verify prevHash links to Ω, not to a retained operational record.
            if (remote.prevHash !== work.prevHash) {
              logger.debug(
                { blockHash, remotePrev: remote.prevHash, ourTip: work.prevHash },
                'P2P sync: block prevHash mismatch — likely fork, skipping',
              );
              return;
            }

            // The claimed residual is not the rule. Recompute it.
            const canonicalDifficulty = chainState.canonicalBody.omega.difficulty;
            if (Number(remote.difficulty) !== canonicalDifficulty) {
              logger.warn(
                { blockHash, claimed: remote.difficulty, canonical: canonicalDifficulty },
                "P2P sync: difficulty is not the canonical difficulty",
              );
              return;
            }
            const remoteTxs = Array.isArray(remote.transactions) ? remote.transactions as Array<{ hash?: string; fee?: number }> : [];
            const committedPressure = pressureEvidence(remote.committedPressure);
            if (committedPressure === null) {
              logger.warn({ blockHash, peerId }, "P2P sync: committed pressure is block evidence");
              return;
            }
            const recomputed = canonicalResidual(
              {
                prevHash: String(remote.prevHash ?? ""),
                merkleRoot: String(remote.merkleRoot ?? "0".repeat(64)),
                timestamp: Number(remote.timestamp),
                nonce: remoteNonce,
                difficulty: canonicalDifficulty,
              },
              remoteTxs.map((t) => ({ hash: String(t.hash ?? ""), fee: Number(t.fee ?? 0) })),
              {
                cumulativeWork: remoteHeight,
                mempoolPressure: committedPressure,
              },
              chainState.canonicalBody.omega.couplings,
            );
            const admission = admitResidual(remoteResidual, recomputed, chainState.admissionTarget);
            if (!admission.ok) {
              logger.warn(
                { blockHash, error: admission.error, claimed: remoteResidual, recomputed },
                "P2P sync: residual refused",
              );
              return;
            }
            remote.residual = admission.residual;

            // Timestamp drift guard: ±300 s
            const now = Math.floor(Date.now() / 1000);
            if (Math.abs(Number(remote.timestamp) - now) > 300) {
              logger.warn({ blockHash, ts: remote.timestamp, now }, 'P2P sync: block timestamp out of drift window — rejected');
              return;
            }

            const producer = chainState.canonicalBody.omega.validators.get(String(remote.miner ?? "").toLowerCase());
            if (!producer || producer.jailed || producer.slashed || producer.bondedStake <= 0) {
              logger.warn({ blockHash, miner: remote.miner }, "P2P sync: miner is not a live validator");
              return;
            }
            const tipTime = chainState.canonicalBody.omega.tipTimestamp;
            if (chainState.canonicalBody.omega.height >= 0 && Number(remote.timestamp) < tipTime) {
              logger.warn({ blockHash, timestamp: remote.timestamp, tipTime }, "P2P sync: timestamp is not monotonic");
              return;
            }

            const beforeHeight = chainState.canonicalBody.omega.height;
            chainState.addBlock(remote);
            if (remote.canonicalSuccessor !== true) {
              logger.warn({ blockHash, height: remoteHeight }, "P2P sync: block is not the successor");
              return;
            }

            const { persistBlock } = await import('./chain/persistence.js');
            const saved = await persistBlock(remote);
            if (!saved) {
              chainState.rollbackToHeight(beforeHeight);
              logger.error({ blockHash, height: remoteHeight }, "P2P sync: block was not persisted — not announced");
              return;
            }

            logger.info({ blockHash, height: remoteHeight, miner: remote.miner, peerId }, 'P2P sync: accepting block from peer');

            // Notify WebSocket clients
            const { broadcast } = await import('./lib/ws-server.js');
            broadcast({
              type: 'new_block',
              data: {
                height:    remote.height,
                hash:      remote.hash,
                txCount:   remote.txCount,
                residual:  remote.residual,
                miner:     remote.miner,
                timestamp: remote.timestamp,
              },
            });
          })
          .catch((err: unknown) => {
            logger.debug({ err, blockHash, peerId }, 'P2P body sync failed (non-fatal)');
          });
      }
    };

    p2pBridge.onTx = (txHash, peerId) => {
      contributionTracker.onTxRelayed(peerId);
      if (chainState) chainState.gossipTx(txHash);
    };

    // mDNS: local peers discovered automatically — log and let the bridge dial them
    p2pBridge.onPeerDiscovered = (peerId, addrs) => {
      contributionTracker.onPeerConnected(peerId);
      logger.info({ peerId, addrs }, 'mDNS local peer auto-dialed');
    };

    // ── P2P Light-node request handler ──────────────────────────────────────
    // When a remote peer queries us for headers or state proofs over the
    // libp2p request-response protocol, we serve the data directly from
    // chain state — no HTTP required on the remote peer's end.
    p2pBridge.onLightNodeRequest = async (requestId, fromPeerId, query) => {
      try {
        const tip = chainState.canonicalTip;
        if (!tip) {
          await p2pBridge.respondToLightNodeRequest(requestId, null, false, 'Chain not initialised');
          return;
        }

        let data: unknown;

        switch (query.kind) {
          case 'tip':
            data = {
              height:    tip.height,
              hash:      tip.hash,
              stateRoot: tip.stateRoot ?? '0'.repeat(64),
              timestamp: tip.timestamp,
            };
            break;

          case 'headers': {
            const from  = Number(query.params?.['from'] ?? 0);
            const to    = Math.min(tip.height, Number(query.params?.['to'] ?? tip.height));
            const hdrs  = [];
            for (let h = from; h <= Math.min(to, from + 200); h++) {
              const b = chainState.blocks[h];
              if (b) hdrs.push({ hash: b.hash, height: b.height, stateRoot: b.stateRoot, prevHash: b.prevHash, timestamp: b.timestamp });
            }
            data = { headers: hdrs, count: hdrs.length };
            break;
          }

          case 'proof_account': {
            const verified = getVerifiedStateRoot(chainState);
            if (!verified.snapshot) {
              await p2pBridge.respondToLightNodeRequest(requestId, null, false, verified.error!.message);
              return;
            }
            const address = String(query.params?.['address'] ?? '');
            const acc     = chainState.ledger.getAccount(address);
            const { smt, protocolStateRoot, operationalRoot } = verified.snapshot;
            const key     = smtKey('acct', address);
            const proof   = smt.proveCompact(key);
            data = {
              address,
              balance: acc.balance,
              nonce: acc.nonce,
              protocolStateRoot,
              operationalRoot,
              stateRoot: protocolStateRoot,
              proof,
            };
            break;
          }

          case 'proof_utxo': {
            const verified = getVerifiedStateRoot(chainState);
            if (!verified.snapshot) {
              await p2pBridge.respondToLightNodeRequest(requestId, null, false, verified.error!.message);
              return;
            }
            const txHash      = String(query.params?.['txHash'] ?? '');
            const outputIndex = Number(query.params?.['outputIndex'] ?? 0);
            const utxo        = chainState.utxoSet.get(txHash, outputIndex);
            const { smt, protocolStateRoot, operationalRoot } = verified.snapshot;
            const key         = smtKey('utxo', `${txHash}:${outputIndex}`);
            const proof       = smt.proveCompact(key);
            data = {
              txHash,
              outputIndex,
              utxo: utxo ?? null,
              protocolStateRoot,
              operationalRoot,
              stateRoot: protocolStateRoot,
              proof,
            };
            break;
          }

          default:
            await p2pBridge.respondToLightNodeRequest(requestId, null, false, `Unknown query kind: ${query.kind}`);
            return;
        }

        logger.debug({ requestId, fromPeerId, kind: query.kind }, 'P2P light-node request served');
        await p2pBridge.respondToLightNodeRequest(requestId, data, true);
      } catch (err) {
        logger.warn({ err, requestId, fromPeerId }, 'P2P light-node request failed');
        await p2pBridge.respondToLightNodeRequest(requestId, null, false, String(err));
      }
    };

    // ── P2P Sync handler ────────────────────────────────────────────────────
    // When a remote peer requests a full block or TX body via the
    // /equilibrium/sync/1.0.0 protocol, serve it from our local store.
    // This eliminates HTTP as a required transport for block body propagation.
    p2pBridge.onSyncRequest = async (requestId, fromPeerId, kind, params) => {
      try {
        if (!chainState) {
          await p2pBridge.respondToSyncRequest(requestId, null, false, 'Chain not initialised');
          return;
        }

        let data: unknown = null;

        switch (kind) {
          case 'block': {
            const hash  = String(params['hash'] ?? '');
            const block = chainState.getBlockByHash(hash);
            if (block) {
              data = block;
            } else {
              await p2pBridge.respondToSyncRequest(requestId, null, false, `block not found: ${hash}`);
              return;
            }
            break;
          }

          case 'blocks': {
            const hashes = Array.isArray(params['hashes']) ? params['hashes'] as string[] : [];
            const blocks = hashes
              .slice(0, 16) // cap batch size to protect mobile peers
              .map((h) => chainState.getBlockByHash(h))
              .filter(Boolean);
            data = blocks;
            break;
          }

          case 'tx': {
            const hash = String(params['hash'] ?? '');
            const tx   = chainState.getTx(hash);
            if (tx) {
              data = tx;
            } else {
              await p2pBridge.respondToSyncRequest(requestId, null, false, `tx not found: ${hash}`);
              return;
            }
            break;
          }

          case 'txs': {
            const hashes = Array.isArray(params['hashes']) ? params['hashes'] as string[] : [];
            const txs = hashes
              .slice(0, 64)
              .map((h) => chainState.getTx(h))
              .filter(Boolean);
            data = txs;
            break;
          }

          default:
            await p2pBridge.respondToSyncRequest(requestId, null, false, `unknown sync kind: ${kind}`);
            return;
        }

        logger.debug({ requestId, fromPeerId, kind }, 'P2P sync request served');
        await p2pBridge.respondToSyncRequest(requestId, data, true);
      } catch (err) {
        logger.warn({ err, requestId, fromPeerId, kind }, 'P2P sync request failed');
        await p2pBridge.respondToSyncRequest(requestId, null, false, String(err));
      }
    };

    // Pre-warm the Groth16 proving key in the background
    void warmupConsensus();

    // Stratum mining pool — enabled when STRATUM_PORT is set (default: off)
    const stratumPort = Number(process.env["STRATUM_PORT"] ?? 0);
    if (stratumPort > 0) {
      const stratum = new StratumServer(stratumPort);
      stratum.attachChain(chainState);
      stratum.listen();
    }
  });

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });

  // Graceful shutdown — close long-lived Rust worker processes cleanly.
  const shutdown = () => {
    p2pBridge.stop();
    closeWorkers();
    server.close(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT",  shutdown);
})().catch((err) => {
  // Ensure fatal init errors are visible and crash the process cleanly.
  console.error("Fatal startup error:", err);
  process.exit(1);
});
