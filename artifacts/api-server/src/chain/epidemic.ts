/**
 * epidemic.ts — Store-and-forward epidemic transaction propagation
 *
 * The standard Gossipsub gossip model is fire-and-forget: if a peer is
 * offline when a TX enters the mempool, they never see it. This module
 * adds a delay-tolerant network (DTN) overlay: transactions are stored
 * locally with a TTL hop-counter and forwarded to reconnecting peers.
 *
 * Protocol:
 *   - Every new TX gets TTL = INITIAL_TTL hops
 *   - On peer_connected: forward all queued TXs the peer hasn't seen
 *   - On receive_tx: decrement TTL, re-queue if TTL > 0
 *   - On block_finalized: evict included TXs from the queue
 *   - Periodic sweep: drop TXs older than MAX_AGE_MS or TTL = 0
 *
 * This is the difference between a chain that works in a coffee shop and
 * one that works on a subway with intermittent signal.
 */

import { logger } from '../lib/logger.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const INITIAL_TTL   = 6;           // max relay hops before a TX is dropped
const MAX_AGE_MS    = 5 * 60_000;  // 5 minutes: hard expiry regardless of TTL
const SWEEP_INTERVAL_MS = 30_000;  // sweep expired entries every 30 s
const MAX_QUEUE_SIZE    = 10_000;  // cap to prevent memory exhaustion

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EpidemicTx {
  txHash:    string;
  /** JSON-encoded signed transaction — full payload for offline-first relay */
  payload:   string;
  ttl:       number;
  /** Peer IDs that have already seen this TX (don't relay back to them) */
  seenBy:    Set<string>;
  createdAt: number; // unix ms
  relays:    number; // total relay count (for contribution scoring)
}

// ── Broadcaster ───────────────────────────────────────────────────────────────

class EpidemicBroadcaster {
  private queue    = new Map<string, EpidemicTx>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  /** Relay function: send a TX hash to the P2P network. Injected to avoid circular imports. */
  private gossipFn?: (txHash: string) => Promise<void>;
  /** Relay full payload to a specific peer. Optional: used when the peer is known offline. */
  private sendToFn?: (peerId: string, txHash: string, payload: string) => Promise<void>;

  start(
    gossipFn: (txHash: string) => Promise<void>,
    sendToFn?: (peerId: string, txHash: string, payload: string) => Promise<void>,
  ): void {
    this.gossipFn  = gossipFn;
    this.sendToFn  = sendToFn;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    logger.info('Epidemic TX broadcaster started');
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.queue.clear();
  }

  /**
   * Enqueue a new transaction for epidemic propagation.
   * Call this whenever a TX enters the local mempool.
   */
  enqueue(txHash: string, payload: string, fromPeerId?: string): void {
    if (this.queue.has(txHash)) {
      // Already queued — just mark the originator as having seen it
      if (fromPeerId) this.queue.get(txHash)!.seenBy.add(fromPeerId);
      return;
    }
    if (this.queue.size >= MAX_QUEUE_SIZE) {
      // Evict oldest entry to make room
      const oldest = [...this.queue.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) this.queue.delete(oldest.txHash);
    }
    const seenBy = new Set<string>();
    if (fromPeerId) seenBy.add(fromPeerId);

    this.queue.set(txHash, {
      txHash,
      payload,
      ttl: INITIAL_TTL,
      seenBy,
      createdAt: Date.now(),
      relays: 0,
    });
  }

  /**
   * Called when a gossip TX is received from a peer.
   * Re-queues with decremented TTL so it propagates further.
   */
  onReceived(txHash: string, payload: string, fromPeerId: string): void {
    const existing = this.queue.get(txHash);
    if (existing) {
      existing.seenBy.add(fromPeerId);
      return; // already queued at same or higher TTL
    }
    if (this.queue.size >= MAX_QUEUE_SIZE) return;

    // Forward with decremented TTL
    this.queue.set(txHash, {
      txHash,
      payload,
      ttl: INITIAL_TTL - 1,
      seenBy: new Set([fromPeerId]),
      createdAt: Date.now(),
      relays: 0,
    });
  }

  /**
   * Called when a peer connects (or reconnects).
   * Flushes all queued TXs the peer hasn't seen yet — this is the core
   * store-and-forward mechanism.
   */
  async onPeerConnected(peerId: string): Promise<void> {
    let flushed = 0;
    for (const tx of this.queue.values()) {
      if (tx.ttl <= 0) continue;
      if (tx.seenBy.has(peerId)) continue;

      try {
        if (this.sendToFn) {
          await this.sendToFn(peerId, tx.txHash, tx.payload);
        } else if (this.gossipFn) {
          await this.gossipFn(tx.txHash);
        }
        tx.seenBy.add(peerId);
        tx.relays++;
        flushed++;
      } catch {
        // Non-fatal: continue flushing other TXs
      }
    }
    if (flushed > 0) {
      logger.debug({ peerId, flushed }, 'Epidemic: flushed queued TXs to reconnected peer');
    }
  }

  /**
   * Called when a block is finalised.
   * Removes all confirmed TXs from the epidemic queue.
   */
  onBlockFinalized(txHashes: string[]): void {
    let evicted = 0;
    for (const h of txHashes) {
      if (this.queue.delete(h)) evicted++;
    }
    if (evicted > 0) {
      logger.debug({ evicted }, 'Epidemic: evicted confirmed TXs from queue');
    }
  }

  /** Evict expired or zero-TTL entries. */
  private sweep(): void {
    const now    = Date.now();
    const before = this.queue.size;
    for (const [hash, tx] of this.queue) {
      if (tx.ttl <= 0 || now - tx.createdAt > MAX_AGE_MS) {
        this.queue.delete(hash);
      }
    }
    const removed = before - this.queue.size;
    if (removed > 0) logger.debug({ removed }, 'Epidemic: swept expired TXs');
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  get queueSize(): number { return this.queue.size; }

  stats(): {
    queueSize:   number;
    totalRelays: number;
    oldestMs:    number;
  } {
    let totalRelays = 0;
    let oldest      = Infinity;
    const now       = Date.now();
    for (const tx of this.queue.values()) {
      totalRelays += tx.relays;
      const age = now - tx.createdAt;
      if (age < oldest) oldest = age;
    }
    return {
      queueSize:   this.queue.size,
      totalRelays,
      oldestMs:    this.queue.size > 0 ? oldest : 0,
    };
  }
}

export const epidemicBroadcaster = new EpidemicBroadcaster();
