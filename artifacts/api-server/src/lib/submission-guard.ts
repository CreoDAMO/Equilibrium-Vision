/**
 * submission-guard.ts
 *
 * Lightweight, zero-dependency primitives for replay protection and rate
 * limiting on the block-submission and Stratum endpoints.
 *
 *  RateLimiter  — sliding-window per-key hit counter
 *  ReplaySet    — bounded LRU set for duplicate-submission detection
 */

// ── Sliding-window rate limiter ────────────────────────────────────────────────

/**
 * Tracks per-key hit timestamps inside a fixed time window.
 * Call tryConsume(key) before processing; it returns true when the request
 * is within the limit and false (without recording the hit) when it exceeds it.
 *
 * Stale keys are pruned on a schedule — call startPruning() once after
 * construction, or call prune() manually.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private pruneTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param limit      Maximum allowed hits per window.
   * @param windowMs   Window duration in milliseconds.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Returns true if the key is within its rate limit and records the hit.
   * Returns false if the limit is already reached (hit is NOT recorded).
   */
  tryConsume(key: string): boolean {
    const now    = Date.now();
    const cutoff = now - this.windowMs;
    const raw    = this.hits.get(key) ?? [];

    // Prune expired timestamps for this key in-place.
    let start = 0;
    while (start < raw.length && raw[start]! <= cutoff) start++;
    const times = start > 0 ? raw.slice(start) : raw;

    if (times.length >= this.limit) {
      // Put back the pruned array so next call is cheaper.
      if (times !== raw) this.hits.set(key, times);
      return false;
    }

    times.push(now);
    this.hits.set(key, times);
    return true;
  }

  /**
   * Returns the number of seconds until the oldest hit for this key expires
   * (i.e., how long the caller must wait before a slot opens up), or 0 when
   * the key is not rate-limited.
   */
  retryAfterSecs(key: string): number {
    const now    = Date.now();
    const cutoff = now - this.windowMs;
    const times  = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (times.length < this.limit) return 0;
    const oldest = times[0]!;
    return Math.ceil((oldest + this.windowMs - now) / 1000);
  }

  /** Remove keys whose entire hit history has expired. */
  prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }

  /**
   * Start a background interval that calls prune() automatically.
   * The interval is set to the window duration.  Call stopPruning() on
   * teardown to avoid leaking the timer.
   */
  startPruning(): this {
    this.pruneTimer = setInterval(() => this.prune(), this.windowMs).unref();
    return this;
  }

  stopPruning(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
  }
}

// ── Bounded replay-detection set ───────────────────────────────────────────────

/**
 * A Map-backed set that tracks recently seen string keys and evicts the
 * oldest entry when the capacity is reached.
 *
 * Typical usage: store `"${prevHash}:${nonce}"` for HTTP block submissions
 * or `"${jobId}:${nonce}:${extraNonce2}"` for Stratum shares so that the
 * same solution cannot be credited twice.
 */
export class ReplaySet {
  private readonly seen = new Map<string, number>(); // key → first-seen ms

  /** @param capacity Maximum number of entries before eviction. */
  constructor(private readonly capacity: number = 1024) {}

  /**
   * Returns true if this key has NOT been seen before and records it.
   * Returns false if the key is already present (duplicate / replay).
   */
  tryAdd(key: string): boolean {
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, Date.now());
    return true;
  }

  /** Returns the number of distinct keys currently tracked. */
  get size(): number {
    return this.seen.size;
  }
}
