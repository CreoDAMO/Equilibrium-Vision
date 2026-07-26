/**
 * p2p-bridge.ts — TypeScript bridge to the Rust p2p-sidecar binary.
 *
 * Replaces the simulated gossip in ChainState with a real libp2p Gossipsub
 * network. The p2p-sidecar binary is spawned once at startup and communicates
 * via newline-delimited JSON on stdin/stdout — the same pattern as consensus-api.
 *
 * Usage:
 *   import { p2pBridge } from './p2p-bridge.js';
 *   p2pBridge.gossipBlock('abc123...');
 *   p2pBridge.gossipTx('def456...');
 *   const peers = await p2pBridge.peers();
 *
 * If the binary is not compiled the bridge silently no-ops so the TS node
 * continues running in simulated mode (existing behaviour preserved).
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
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
}

export interface P2PPeer {
  peerId:  string;
  address?: string;
}

// ── P2P Bridge class ──────────────────────────────────────────────────────────

class P2PBridge {
  private proc:      ChildProcess | null = null;
  private buffer:    string = '';
  private queue:     PendingCall[] = [];
  private available: boolean = false;

  /** Callback invoked when a block is gossiped from a remote peer. */
  onBlock?: (blockHash: string, peerId: string) => void;
  /** Callback invoked when a tx is gossiped from a remote peer. */
  onTx?:    (txHash: string, peerId: string) => void;
  /** Callback invoked when a peer connects or disconnects. */
  onPeer?:  (event: 'connected' | 'disconnected', peerId: string) => void;

  start(): void {
    const binaryPath = resolveP2pSidecar();
    if (!fs.existsSync(binaryPath)) {
      logger.info('p2p-sidecar binary not found — running in simulated gossip mode');
      return;
    }

    try {
      this.proc = spawn(binaryPath, [], {
        env: {
          ...process.env,
          P2P_PORT:      process.env['P2P_PORT'] ?? '9000',
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

  async gossipBlock(blockHash: string): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({ method: 'gossip_block', blockHash }).catch(() => {/* fire and forget */});
  }

  async gossipTx(txHash: string): Promise<void> {
    if (!this.isAvailable) return;
    await this.send({ method: 'gossip_tx', txHash }).catch(() => {/* fire and forget */});
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

  // ── Private ─────────────────────────────────────────────────────────────────

  private send<T>(payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error('p2p-sidecar not running'));
        return;
      }
      this.queue.push({
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.proc.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    // Check if this is an unsolicited event (has "event" key)
    if (typeof parsed['event'] === 'string') {
      this.handleEvent(parsed);
      return;
    }

    // Otherwise it's a response to a queued command
    const waiter = this.queue.shift();
    if (waiter) {
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
    }
  }

  private rejectAll(err: Error): void {
    while (this.queue.length > 0) {
      this.queue.shift()!.reject(err);
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const p2pBridge = new P2PBridge();
