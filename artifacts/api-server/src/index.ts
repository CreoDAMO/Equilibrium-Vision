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
import { SparseMerkleTree, smtKey, smtValue } from "./chain/smt.js";

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

    p2pBridge.onBlock = (blockHash, peerId) => {
      contributionTracker.onBlockRelayed(peerId);
    };

    p2pBridge.onTx = (txHash, peerId) => {
      contributionTracker.onTxRelayed(peerId);
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
        const tip = chainState.latestBlock;
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
            const address = String(query.params?.['address'] ?? '');
            const acc     = chainState.ledger.getAccount(address);
            const smt     = chainState._stateSmt ?? new SparseMerkleTree();
            const key     = smtKey('acct', address);
            const proof   = smt.proveCompact(key);
            data = { address, balance: acc.balance, nonce: acc.nonce, stateRoot: tip.stateRoot, proof };
            break;
          }

          case 'proof_utxo': {
            const txHash      = String(query.params?.['txHash'] ?? '');
            const outputIndex = Number(query.params?.['outputIndex'] ?? 0);
            const utxo        = chainState.utxoSet.get(txHash, outputIndex);
            const smt         = chainState._stateSmt ?? new SparseMerkleTree();
            const key         = smtKey('utxo', `${txHash}:${outputIndex}`);
            const proof       = smt.proveCompact(key);
            data = { txHash, outputIndex, utxo: utxo ?? null, stateRoot: tip.stateRoot, proof };
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
