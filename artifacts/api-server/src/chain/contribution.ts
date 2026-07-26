/**
 * contribution.ts — Proof-of-Contribution scoring
 *
 * Every node in a server-free mobile blockchain contributes differently:
 * some run hot, some mine rarely, some relay a lot. This module tracks a
 * per-peer contribution score that can be used as a tiebreaker in leader
 * election and as a signal for the network's overall health.
 *
 * Score formula:
 *   score = uptimeRatio × thermalMargin × ln(1 + blocksRelayed)
 *
 *   uptimeRatio   ∈ [0,1] — fraction of observed time the peer was online
 *   thermalMargin ∈ [0,1] — headroom before thermal throttling (1 = cool)
 *   blocksRelayed ∈ [0,∞) — blocks this peer has relayed in the epoch
 *
 * Why this formula?
 *   - Logarithm caps the relay bonus to prevent "relay-spam" Sybil attacks
 *   - Thermal margin preserves battery health: a phone mining at 100% heat
 *     scores lower, naturally shedding load to cooler devices
 *   - Uptime prevents free-riding: you must stay connected to score
 *
 * The score is included in block metadata and served at /chain/contributions.
 * Mobile clients use it to pick which peers to sync from.
 */

import { createHash } from 'crypto';
import { logger } from '../lib/logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContributionScore {
  peerId:        string;
  /** Miner address associated with this peer (if known) */
  address?:      string;
  uptimeRatio:   number;   // 0–1
  thermalMargin: number;   // 0–1
  blocksRelayed: number;
  txsRelayed:    number;
  score:         number;   // uptimeRatio × thermalMargin × ln(1 + blocksRelayed)
  /** ISO timestamp of first observation */
  since:         string;
  /** ISO timestamp of last update */
  lastSeen:      string;
  /** Deterministic fingerprint: sha256(peerId + score.toFixed(6)) */
  fingerprint:   string;
}

interface PeerRecord {
  peerId:        string;
  address?:      string;
  firstSeen:     number;   // unix ms
  lastSeen:      number;
  onlineSince:   number | null; // ms since last connect (null = disconnected)
  totalOnlineMs: number;
  thermalMargin: number;
  blocksRelayed: number;
  txsRelayed:    number;
}

// ── Epoch ─────────────────────────────────────────────────────────────────────

const EPOCH_MS   = 24 * 60 * 60_000; // 24 h rolling window
const MAX_PEERS  = 10_000;

// ── Tracker ───────────────────────────────────────────────────────────────────

class ContributionTracker {
  private peers  = new Map<string, PeerRecord>();
  private startMs = Date.now();

  // ── Events ────────────────────────────────────────────────────────────────

  onPeerConnected(peerId: string, address?: string): void {
    const now = Date.now();
    let rec = this.peers.get(peerId);
    if (!rec) {
      if (this.peers.size >= MAX_PEERS) return; // prevent unbounded growth
      rec = {
        peerId,
        address,
        firstSeen: now,
        lastSeen: now,
        onlineSince: now,
        totalOnlineMs: 0,
        thermalMargin: 1.0,
        blocksRelayed: 0,
        txsRelayed: 0,
      };
      this.peers.set(peerId, rec);
    } else {
      rec.onlineSince = now;
      rec.lastSeen    = now;
      if (address) rec.address = address;
    }
  }

  onPeerDisconnected(peerId: string): void {
    const now = Date.now();
    const rec = this.peers.get(peerId);
    if (!rec) return;
    if (rec.onlineSince !== null) {
      rec.totalOnlineMs += now - rec.onlineSince;
      rec.onlineSince = null;
    }
    rec.lastSeen = now;
  }

  /** Report the thermal margin from the last mining cycle (0 = hot, 1 = cool). */
  onThermalReport(peerId: string, thermalMargin: number): void {
    const rec = this.peers.get(peerId);
    if (!rec) return;
    // Exponential moving average: weight new reading at 20%
    rec.thermalMargin = 0.8 * rec.thermalMargin + 0.2 * Math.max(0, Math.min(1, thermalMargin));
  }

  onBlockRelayed(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (rec) rec.blocksRelayed++;
  }

  onTxRelayed(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (rec) rec.txsRelayed++;
  }

  /** Report our own local thermal margin (for the self entry). */
  reportLocalThermal(thermalMargin: number): void {
    this.onThermalReport('local', thermalMargin);
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  private computeScore(rec: PeerRecord): ContributionScore {
    const now       = Date.now();
    const epochMs   = Math.min(EPOCH_MS, now - this.startMs);
    const onlineMs  = rec.totalOnlineMs +
      (rec.onlineSince !== null ? now - rec.onlineSince : 0);
    const uptimeRatio   = epochMs > 0 ? Math.min(1, onlineMs / epochMs) : 0;
    const thermalMargin = rec.thermalMargin;
    const score         = uptimeRatio * thermalMargin * Math.log1p(rec.blocksRelayed);
    const raw           = `${rec.peerId}:${score.toFixed(6)}`;
    const fingerprint   = createHash('sha256').update(raw).digest('hex').slice(0, 16);

    return {
      peerId:        rec.peerId,
      address:       rec.address,
      uptimeRatio:   +uptimeRatio.toFixed(4),
      thermalMargin: +thermalMargin.toFixed(4),
      blocksRelayed: rec.blocksRelayed,
      txsRelayed:    rec.txsRelayed,
      score:         +score.toFixed(6),
      since:         new Date(rec.firstSeen).toISOString(),
      lastSeen:      new Date(rec.lastSeen).toISOString(),
      fingerprint,
    };
  }

  getScore(peerId: string): number {
    const rec = this.peers.get(peerId);
    if (!rec) return 0;
    return this.computeScore(rec).score;
  }

  getLeaderboard(limit = 50): ContributionScore[] {
    return [...this.peers.values()]
      .map((r) => this.computeScore(r))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  networkThermalHealth(): number {
    if (this.peers.size === 0) return 1.0;
    let sum = 0;
    for (const r of this.peers.values()) sum += r.thermalMargin;
    return +(sum / this.peers.size).toFixed(4);
  }

  stats(): {
    peerCount:       number;
    activePeers:     number;
    networkThermal:  number;
    topScore:        number;
  } {
    let activePeers = 0;
    let topScore    = 0;
    for (const r of this.peers.values()) {
      if (r.onlineSince !== null) activePeers++;
      const s = this.computeScore(r).score;
      if (s > topScore) topScore = s;
    }
    return {
      peerCount:      this.peers.size,
      activePeers,
      networkThermal: this.networkThermalHealth(),
      topScore: +topScore.toFixed(6),
    };
  }

  /** Evict peers not seen in the last 7 days. */
  prune(): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    let pruned = 0;
    for (const [id, r] of this.peers) {
      if (r.lastSeen < cutoff && r.onlineSince === null) {
        this.peers.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) logger.debug({ pruned }, 'Contribution: pruned stale peer records');
  }
}

export const contributionTracker = new ContributionTracker();
