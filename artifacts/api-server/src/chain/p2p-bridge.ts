/**
 * p2p-bridge.ts — TypeScript bridge to the Rust p2p-sidecar binary.
 *
 * Replaces the simulated gossip in ChainState with a real libp2p Gossipsub
 * network. The p2p-sidecar binary is spawned once at startup and communicates
 * via newline-delimited JSON on stdin/stdout — the same pattern as consensus-api.
 *
 * Protocol extensions over the original:
 *   - Correlation IDs on every command (fixes the broken FIFO assumption — the
 *     original assumed responses arrive in the exact order commands were sent,
 *     which breaks under concurrent queries).
 *   - queryLightNode(peerId, query) — request headers/proofs from a peer
 *     directly over the libp2p request-response protocol without an HTTP server.
 *   - respondToLightNodeRequest(requestId, data) — answer an inbound light-node
 *     query received from a remote peer.
 *   - onPeerDiscovered — callback for mDNS-discovered peers (LAN, no seed needed).
 *
 * Usage:
 *   import { p2pBridge } from './p2p-bridge.js';
 *   p2pBridge.gossipBlock('abc123...');
 *   const proof = await p2pBridge.queryLightNode('QmPeer...', { kind: 'proof_account', params: { address: '...' } });
 *
 * If the binary is not compiled the bridge silently no-ops so the TS node
 * continues running in simulated mode (existing behaviour preserved).
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveP2pSidecar(): string {
  const candidates = [
    path.resolve(process.cwd(), 'p2p-sidecar'),
    path.resolve(__dirname, '../../', 'p2p-sidecar'),
    path.resolve(__dirname, '../', 'p2p-sidecar'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0]!;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PendingCall {
  resolve: (v: unknown) => void;
  reject:  (e: Error) => void;
  timer:   ReturnType<typeof setTimeout>;
}

export interface P2PPeer {
  peerId:  string;
  address?: string;
}

export interface P2PListenAddress {
  addr: string;
  /** True for UDP QUIC addresses; false for TCP addresses. */
  quic: boolean;
}

export interface LightNodeQuery {
  /** "tip" | "headers" | "sync" | "proof_account" | "proof_utxo" */
  kind:   string;
  params?: Record<string, unknown>;
}

export interface LightNodeResponse {
  ok:    boolean;
  data?: unknown;
  error?: string;
}

// ── P2P Bridge class ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000; // 10 s per command

class P2PBridge {
  private proc:      ChildProcess | null = null;
  private buffer:    string = '';
  /**
   * Correlation-ID map: id → pending promise.
   * Replaces the FIFO queue which broke under concurrent requests.
   */
  private pending:   Map<string, PendingCall> = new Map();
  private available: boolean = false;

  // ── Callbacks ──────────────────────────────────────────────────────────────

  /** Called when a block is gossiped from a remote peer. */
  onBlock?: (blockHash: string, peerId: string) => void;
  /** Called when a tx is gossiped from a remote peer. */
  onTx?:   (txHash: string, peerId: string) => void;
  /** Called when a peer connects or disconnects. */
  onPeer?: (event: 'connected' | 'disconnected', peerId: string) => void;
  /**
   * Called when mDNS discovers a new peer on the local network.
   * The bridge automatically dials discovered peers; this callback lets
   * the chain layer update its peer list without a round-trip.
   */
  onPeerDiscovered?: (peerId: string, addrs: string[]) => void;
  /** Called whenever the sidecar advertises a TCP or QUIC listen address. */
  onListenAddress?: (address: P2PListenAddress) => void;
  /**
   * Called when a remote peer sends us a light-node query.
   * The handler should compute the response and call respondToLightNodeRequest().
   */
  onLightNodeRequest?: (requestId: string, fromPeerId: string, query: LightNodeQuery) => void;
  /**
   * Called when a remote peer requests a full block or TX body via the
   * /equilibrium/sync/1.0.0 request-response protocol.
   * The handler should fetch the data and call respondToSyncRequest().
   */
  onSyncRequest?: (requestId: string, fromPeerId: string, kind: string, params: Record<string, unknown>) => void;
  /**
   * Called when a full block body is received via the block-bodies Gossipsub topic.
   * Emitted by mobile miners after a successful HTTP submit so desktop nodes (and
   * other phones) can accept the block without a separate sync RR fetch.
   * The `body` object carries: hash, height, prevHash, nonce, residual,
   * timestamp, miner, difficulty.
   */
  onBlockBody?: (body: Record<string, unknown>, peerId: string) => void;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    const binaryPath = resolveP2pSidecar();
    const requireP2p =
      process.env["NODE_ENV"] === "production" ||
      process.env["REQUIRE_P2P_SIDECAR"] === "true";

    if (!fs.existsSync(binaryPath)) {
      if (requireP2p) {
        throw new Error(
          "P2P sidecar required in production (REQUIRE_P2P_SIDECAR / NODE_ENV=production). " +
            "Start p2p-sidecar or unset the requirement for local-only runs.",
        );
      }
      logger.info('p2p-sidecar binary not found — running in simulated gossip mode');
      return;
    }

    try {
      this.proc = spawn(binaryPath, [], {
        env: {
          ...process.env,
          P2P_PORT:      process.env['P2P_PORT'] ?? '9000',
          P2P_QUIC_PORT: process.env['P2P_QUIC_PORT'] ?? '9001',
          P2P_BOOTSTRAP: process.env['P2P_BOOTSTRAP'] ?? '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.handleLine(line.trim());
        }
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        const msg = chunk.toString().trim();
        if (msg) logger.debug({ msg }, 'p2p-sidecar');
      });

      this.proc.on('exit', (code) => {
        logger.warn({ code }, 'p2p-sidecar exited — gossip reverts to simulated mode');
        this.available = false;
        this.proc = null;
        this.rejectAll(new Error(`p2p-sidecar exited with code ${code}`));
      });

      this.available = true;
      logger.info({ port: process.env['P2P_PORT'] ?? '9000' }, 'p2p-sidecar started');
    } catch (err) {
      logger.warn({ err }, 'Failed to start p2p-sidecar — simulated gossip mode');
    }
  }

  stop(): void {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch { /* ignore */ }
      this.proc = null;
    }
    this.available = false;
    this.rejectAll(new Error('p2p-sidecar stopped'));
  }

  get isAvailable(): boolean {
    return this.available && this.proc !== null;
  }

  // ── Outbound commands ──────────────────────────────────────────────────────

  async gossipBlock(blockHash: string): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({ method: 'gossip_block', blockHash }).catch(() => {/* fire and forget */});
  }

  async gossipTx(txHash: string): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({ method: 'gossip_tx', txHash }).catch(() => {/* fire and forget */});
  }

  /**
   * Publish a full block body JSON to connected peers via the block-bodies
   * Gossipsub topic, so mobile miners and desktop nodes can store and serve
   * it via sync RR without an HTTP cloud node.
   *
   * @param bodyJson  JSON string with fields: hash, height, prevHash, nonce,
   *                  residual, timestamp, miner, difficulty.
   */
  async gossipBlockBody(bodyJson: string): Promise<void> {
    if (!this.isAvailable) return;
    try {
      const data = JSON.parse(bodyJson) as Record<string, unknown>;
      await this.send({ method: 'gossip_block_body', data }).catch(() => {/* fire and forget */});
    } catch {
      logger.warn('p2p-bridge: gossipBlockBody called with invalid JSON — skipped');
    }
  }

  async peers(): Promise<P2PPeer[]> {
    if (!this.isAvailable) return [];
    try {
      const res = await this.send<{ ok: boolean; peers: P2PPeer[] }>({ method: 'peers' });
      return res.peers ?? [];
    } catch {
      return [];
    }
  }

  async connectPeer(multiaddr: string): Promise<boolean> {
    if (!this.isAvailable) return false;
    try {
      const res = await this.send<{ ok: boolean }>({ method: 'connect', addr: multiaddr });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listenAddrs(): Promise<string[]> {
    if (!this.isAvailable) return [];
    try {
      const res = await this.send<{ ok: boolean; addrs: string[] }>({ method: 'listen_addrs' });
      return res.addrs ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Query a remote peer's light-node data directly over libp2p request-response.
   * No HTTP server required — the peer's sidecar handles the protocol natively.
   *
   * @param peerId  The libp2p PeerId string of the target peer.
   * @param query   What to request (tip, headers, proof_account, proof_utxo…).
   * @returns       The peer's response data, or throws on timeout/error.
   */
  async queryLightNode(peerId: string, query: LightNodeQuery): Promise<LightNodeResponse> {
    if (!this.isAvailable) throw new Error('p2p-sidecar not available');
    const res = await this.send<{ ok: boolean; id: string; data?: unknown; error?: string }>({
      method: 'query_peer',
      peerId,
      query,
    });
    return { ok: res.ok, data: res.data, error: res.error };
  }

  /**
   * Send a response to an inbound light-node request from a remote peer.
   * Call this from the onLightNodeRequest handler after computing the proof.
   *
   * @param requestId  The requestId from the onLightNodeRequest callback.
   * @param data       The response payload (will be JSON-serialised).
   */
  async respondToLightNodeRequest(
    requestId: string,
    data: unknown,
    ok = true,
    error?: string,
  ): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({
      method: 'lightnode_response',
      requestId,
      ok,
      data,
      error,
    }).catch(() => {/* best-effort */});
  }

  /**
   * Request a full block or TX body from a remote peer via the
   * /equilibrium/sync/1.0.0 protocol. Unlike gossip (hashes only), this
   * fetches the actual body directly from the peer — no HTTP required.
   *
   * @param peerId  Target peer's libp2p PeerId string.
   * @param kind    "block" | "blocks" | "tx" | "txs"
   * @param params  Query params, e.g. { hash: "abc123..." }
   */
  async requestSync(
    peerId: string,
    kind: string,
    params?: Record<string, unknown>,
  ): Promise<LightNodeResponse> {
    if (!this.isAvailable) throw new Error('p2p-sidecar not available');
    const res = await this.send<{ ok: boolean; id: string; data?: unknown; error?: string }>({
      method: 'query_sync',
      peerId,
      query: { kind, params: params ?? {} },
    });
    return { ok: res.ok, data: res.data, error: res.error };
  }

  /**
   * Send a response to an inbound sync request (body fetch from a remote peer).
   *
   * @param requestId  The requestId from the onSyncRequest callback.
   * @param data       The block or TX body to return (JSON-serialisable).
   */
  async respondToSyncRequest(
    requestId: string,
    data: unknown,
    ok = true,
    error?: string,
  ): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({
      method: 'sync_response',
      requestId,
      ok,
      data,
      error,
    }).catch(() => {/* best-effort */});
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Send a command to the sidecar with a correlation ID.
   * The ID is included in the command payload; the sidecar echoes it in the
   * response so concurrent commands can be matched without FIFO assumptions.
   */
  private send<T>(payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error('p2p-sidecar not running'));
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`p2p-sidecar command timed out (id=${id}, method=${String(payload['method'])})`));
        }
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      this.proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    // Unsolicited event — dispatch to the appropriate callback
    if (typeof parsed['event'] === 'string') {
      this.handleEvent(parsed);
      return;
    }

    // Correlated response: resolve by ID
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : null;
    if (id) {
      const waiter = this.pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.pending.delete(id);
        if (parsed['ok'] === false) {
          waiter.reject(new Error(String(parsed['error'] ?? 'p2p error')));
        } else {
          waiter.resolve(parsed);
        }
        return;
      }
    }

    // Legacy fallback: if no id in response, resolve oldest pending (compat)
    if (this.pending.size > 0) {
      const [firstId, waiter] = [...this.pending.entries()][0]!;
      clearTimeout(waiter.timer);
      this.pending.delete(firstId);
      if (parsed['ok'] === false) {
        waiter.reject(new Error(String(parsed['error'] ?? 'p2p error')));
      } else {
        waiter.resolve(parsed);
      }
    }
  }

  private handleEvent(evt: Record<string, unknown>): void {
    const type = evt['event'] as string;
    switch (type) {
      case 'block':
        this.onBlock?.(String(evt['blockHash'] ?? ''), String(evt['peerId'] ?? ''));
        break;
      case 'tx':
        this.onTx?.(String(evt['txHash'] ?? ''), String(evt['peerId'] ?? ''));
        break;
      case 'peer_connected':
        this.onPeer?.('connected', String(evt['peerId'] ?? ''));
        break;
      case 'peer_disconnected':
        this.onPeer?.('disconnected', String(evt['peerId'] ?? ''));
        break;

      // mDNS local discovery — the sidecar auto-dials; we surface it here
      case 'peer_discovered': {
        const peerId = String(evt['peerId'] ?? '');
        const addrs  = Array.isArray(evt['addrs'])
          ? (evt['addrs'] as unknown[]).map(String)
          : [];
        logger.info({ peerId, addrs }, 'mDNS: local peer discovered');
        this.onPeerDiscovered?.(peerId, addrs);
        break;
      }

      case 'listen_addr': {
        const addr = String(evt['addr'] ?? '');
        if (addr) {
          this.onListenAddress?.({
            addr,
            quic: addr.includes('/udp/') && addr.includes('/quic-v1'),
          });
        }
        break;
      }

      // Inbound light-node query from a remote peer
      case 'lightnode_request': {
        const requestId  = String(evt['requestId'] ?? '');
        const fromPeerId = String(evt['fromPeerId'] ?? '');
        const query      = (evt['query'] ?? {}) as LightNodeQuery;
        this.onLightNodeRequest?.(requestId, fromPeerId, query);
        break;
      }

      // Inbound sync request: a remote peer wants a full block or TX body
      case 'sync_request': {
        const requestId  = String(evt['requestId'] ?? '');
        const fromPeerId = String(evt['fromPeerId'] ?? '');
        const q          = (evt['query'] ?? {}) as { kind?: string; params?: Record<string, unknown> };
        this.onSyncRequest?.(requestId, fromPeerId, q.kind ?? 'block', q.params ?? {});
        break;
      }

      // Inbound full block body gossiped from a mobile miner after HTTP submit.
      // Allows the desktop node to accept the block without a sync RR round-trip.
      case 'block_body': {
        const body   = (evt['body'] ?? {}) as Record<string, unknown>;
        const peerId = String(evt['peerId'] ?? '');
        this.onBlockBody?.(body, peerId);
        break;
      }

      // Identify confirmed for a peer — currently informational
      case 'peer_identified': {
        const peerId = String(evt['peerId'] ?? '');
        logger.debug({ peerId }, 'p2p-bridge: peer identified (multiaddrs registered in DHT)');
        break;
      }

      default:
        logger.debug({ type }, 'p2p-bridge: unknown event type');
    }
  }

  private rejectAll(err: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      this.pending.delete(id);
      waiter.reject(err);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const p2pBridge = new P2PBridge();
