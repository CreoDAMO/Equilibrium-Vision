/**
 * variational-ai/bridge.ts
 *
 * Async wrapper around the `variational-ai-cli` and
 * `variational-ai-arbitrage-cli` Rust binaries.
 *
 * Each binary supports two modes:
 *   - One-shot (default): read all stdin → process → exit (legacy)
 *   - Daemon (--daemon):  read one JSON line per request, write one JSON
 *     response line, keep running — used by CliWorker below.
 *
 * CliWorker keeps a single Rust process alive and routes concurrent calls
 * through a serial queue (the binary is single-threaded), eliminating the
 * per-call process-spawn overhead (~100–300 ms on cold Replit containers).
 * If the process crashes it is transparently restarted on the next call.
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// NOTE: import.meta.url is NOT rewritten per-source-file by esbuild when
// bundling into a single dist file — every module sees the *bundle's* own
// URL, so a path relative to __dirname assumes the wrong directory depth
// once bundled (dist/ sits one level shallower than src/variational-ai/ did).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveCliBinary(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), name),
    path.resolve(__dirname, '../../', name),
    path.resolve(__dirname, '../', name),
  ];
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0]!;
}
const CLI_PATH          = resolveCliBinary('variational-ai-cli');
const ARBITRAGE_CLI_PATH = resolveCliBinary('variational-ai-arbitrage-cli');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VerifyResidualRequest {
  /** Support-set feature vectors, row-major (n_support × input_dim). */
  support_data:    number[];
  /** Support-set binary labels (0.0 or 1.0). */
  support_labels:  number[];
  /** Number of features per sample (e.g. 64 for 8×8 MNIST). */
  input_dim:       number;
  /** Number of hidden units in the empirical NTK MLP. */
  hidden_dim:      number;
  /** L2 regularisation coefficient. */
  lambda:          number;
  /** Seed for deterministic weight initialisation. */
  seed:            number;
  /** Claimed residual from the proposer (fixed-point, scaled ×1e12). */
  claimed_residual: number;
  /** Acceptance tolerance (fixed-point, scaled ×1e12). Default: 1000. */
  epsilon?:        number;
  /** CG convergence tolerance. Default: 1e-6. */
  tol?:            number;
  /** Max CG iterations. Default: 100. */
  max_iter?:       number;
}

export interface VerifyResidualResponse {
  /** Computed residual in fixed-point (scaled ×1e12). */
  computed_residual_fp:  number;
  /** Computed residual as f64. */
  computed_residual_f64: number;
  /** Whether the residual matches within epsilon. */
  valid:                 boolean;
  /** Epsilon used for comparison. */
  epsilon:               number;
}

// ── CliWorker ─────────────────────────────────────────────────────────────────

interface Waiter {
  resolve: (line: string) => void;
  reject:  (err: Error)   => void;
  timer:   ReturnType<typeof setTimeout>;
}

/**
 * Manages a long-lived Rust CLI process in --daemon mode.
 *
 * Requests are serialised: only one is in-flight at a time (the binary is
 * single-threaded).  Additional callers queue and are served in FIFO order.
 * If the process dies it is lazily restarted on the next call.
 *
 * Design invariants
 * ─────────────────
 * 1. Each process has a numeric `generation`.  stdout handlers capture the
 *    generation at spawn time and silently discard data from stale processes,
 *    preventing late output from a timed-out/crashed process from resolving a
 *    waiter belonging to the next generation.
 * 2. `drain()` always settles every waiter it dequeues — empty lines (protocol
 *    errors) cause an explicit rejection rather than leaving the promise hung.
 * 3. The process handle is nulled only *after* the `close` event fires, not
 *    when the timeout fires.  The timeout kills the process (triggering that
 *    event) so the race window is eliminated.
 */
class CliWorker {
  private proc:       ChildProcess | null = null;
  private generation  = 0;
  private buffer      = '';
  private queue:      Waiter[] = [];
  private closed      = false;

  constructor(
    private readonly binaryPath:      string,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** Send one request object, return the parsed response. */
  async call<T>(request: unknown, timeoutMs = this.defaultTimeoutMs): Promise<T> {
    const line = await this.send(JSON.stringify(request), timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Worker (${path.basename(this.binaryPath)}) returned invalid JSON: ${line}`);
    }
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      throw new Error(`Worker error: ${(parsed as { error: string }).error}`);
    }
    return parsed as T;
  }

  /** Shut down the underlying process (called on server shutdown). */
  close(): void {
    this.closed = true;
    if (this.proc) {
      try { this.proc.stdin?.end(); } catch { /* ignore */ }
      // Do not null this.proc here — the 'close' handler will do it.
    }
    this.rejectAll(new Error('CliWorker closed'));
  }

  // ── private ────────────────────────────────────────────────────────────────

  private rejectAll(err: Error): void {
    const pending = this.queue.splice(0);
    for (const w of pending) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  private ensureRunning(): void {
    if (this.proc || this.closed) return;

    const gen = ++this.generation;
    const proc = spawn(this.binaryPath, ['--daemon'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc   = proc;
    this.buffer = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      // Ignore data from a stale generation (e.g. after a timeout-kill).
      if (gen !== this.generation) return;
      this.buffer += chunk.toString();
      this.drain();
    });

    const onExit = () => {
      if (gen !== this.generation) return; // already superseded
      this.proc = null;
      // Reject everything still queued — callers must retry.
      this.rejectAll(new Error(`${path.basename(this.binaryPath)} exited unexpectedly`));
    };
    proc.on('error', onExit);
    proc.on('close', onExit);
  }

  /**
   * Dispatch queued waiters against complete lines already in the buffer.
   * Every dequeued waiter is always settled (resolved or rejected).
   */
  private drain(): void {
    let nl: number;
    while (this.queue.length > 0 && (nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      const w = this.queue.shift()!;
      clearTimeout(w.timer);
      if (line) {
        w.resolve(line);
      } else {
        // An empty newline from the daemon is a protocol error.
        w.reject(new Error(`${path.basename(this.binaryPath)} daemon emitted an empty response line`));
      }
    }
  }

  private send(json: string, timeoutMs: number): Promise<string> {
    if (this.closed) {
      return Promise.reject(new Error('CliWorker is closed'));
    }

    return new Promise<string>((resolve, reject) => {
      this.ensureRunning();

      const timer = setTimeout(() => {
        // Remove this waiter from the queue.
        const idx = this.queue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);

        // Kill the process.  The 'close' event will fire and null this.proc,
        // and bump the generation so any buffered output is discarded.
        if (this.proc) {
          // Increment generation *before* kill so the close handler recognises
          // this as an intentional supersession and does not rejectAll.
          const killedGen = this.generation;
          this.generation++;          // invalidate old process's output
          this.proc.once('close', () => {
            if (this.generation === killedGen + 1) this.proc = null; // clean up
          });
          try { this.proc.kill('SIGKILL'); } catch { /* ignore */ }
          this.proc   = null;         // stop new sends going to the dying process
          this.buffer = '';           // discard any partial output from old gen
        }

        reject(new Error(`${path.basename(this.binaryPath)} timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      this.queue.push({ resolve, reject, timer });

      try {
        this.proc!.stdin!.write(json + '\n');
      } catch (err) {
        // stdin closed unexpectedly — remove from queue and reject immediately.
        const idx = this.queue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

// Singleton workers — one per binary.  Lazy: the process is only spawned when
// the first call arrives.
const residualWorker   = new CliWorker(CLI_PATH,           30_000);
const arbitrageWorker  = new CliWorker(ARBITRAGE_CLI_PATH, 30_000);

/** Call on graceful server shutdown to clean up the background processes. */
export function closeWorkers(): void {
  residualWorker.close();
  arbitrageWorker.close();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the Rust worker to verify a model's residual claim.
 * The worker process is kept alive between calls (--daemon mode).
 */
export async function computeResidual(
  req: VerifyResidualRequest,
  timeoutMs = 30_000,
): Promise<VerifyResidualResponse> {
  return residualWorker.call<VerifyResidualResponse>(req, timeoutMs);
}

/**
 * Convenience wrapper that resolves to `true` if the residual is valid,
 * `false` if invalid, and throws on subprocess/parse errors.
 */
export async function verifyResidual(req: VerifyResidualRequest): Promise<boolean> {
  const res = await computeResidual(req);
  return res.valid;
}

// ── Arbitrage detection ──────────────────────────────────────────────────────

export interface ArbitragePoolInput {
  pool_id:   string;
  token_a:   string;
  token_b:   string;
  reserve_a: number;
  reserve_b: number;
  fee:       number;
}

export interface ArbitrageOpportunitiesRequest {
  pools: ArbitragePoolInput[];
  /** L2 regularisation on trade size. Default: 1e-6. */
  lambda?: number;
  /** Cap on the number of cycles returned. Default: 5. */
  max_opportunities?: number;
}

export interface ArbitrageOpportunity {
  tokens: string[];
  poolIds: string[];
  hopCount: number;
  rates: number[];
  profitFactor: number;
  optimalAmountIn: number;
  expectedProfit: number;
}

export interface ArbitrageOpportunitiesResponse {
  opportunities: ArbitrageOpportunity[];
  count: number;
}

/**
 * Call the Rust worker to scan DEX pool snapshots for profitable arbitrage
 * cycles (Bellman-Ford negative-cycle detection).
 */
export async function findArbitrageOpportunities(
  req: ArbitrageOpportunitiesRequest,
  timeoutMs = 30_000,
): Promise<ArbitrageOpportunitiesResponse> {
  return arbitrageWorker.call<ArbitrageOpportunitiesResponse>(req, timeoutMs);
}
