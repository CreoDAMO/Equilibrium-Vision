/**
 * variational-ai/bridge.ts
 *
 * Async wrapper around the `variational-ai-cli` Rust binary.
 * TypeScript calls this to verify an on-chain model residual claim without
 * embedding any Rust logic directly in Node.js.
 *
 * The CLI reads a JSON request from stdin and writes a JSON response to stdout.
 * Exit code: 0 = valid residual, 1 = invalid residual, 2 = error.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Resolve the CLI binaries relative to the api-server package root.
//
// NOTE: import.meta.url is NOT rewritten per-source-file by esbuild when
// bundling into a single dist file — every module sees the *bundle's* own
// URL, so a path relative to __dirname assumes the wrong directory depth
// once bundled (dist/ sits one level shallower than src/variational-ai/ did).
// Falling back through cwd- and dirname-relative candidates keeps this
// correct in both `tsx` dev mode and the bundled `dist/index.mjs` runtime.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveCliBinary(name: string): string {
  const candidates = [
    path.resolve(process.cwd(), name),
    path.resolve(__dirname, '../../', name),
    path.resolve(__dirname, '../', name),
  ];
  return candidates.find(c => fs.existsSync(c)) ?? candidates[0]!;
}
const CLI_PATH  = resolveCliBinary('variational-ai-cli');
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the Rust CLI to verify a model's residual claim.
 *
 * @param req  Verification request (see VerifyResidualRequest).
 * @param timeoutMs  Kill the subprocess if it takes longer (default: 30 s).
 */
export async function computeResidual(
  req: VerifyResidualRequest,
  timeoutMs = 30_000,
): Promise<VerifyResidualResponse> {
  const json = JSON.stringify(req);
  return new Promise((resolve, reject) => {
    const proc = spawn(CLI_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error(`variational-ai-cli timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected

      if (code === 2) {
        return reject(new Error(`variational-ai-cli error: ${stderr.trim() || stdout.trim()}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as VerifyResidualResponse;
        resolve(parsed);
      } catch (e) {
        reject(new Error(`variational-ai-cli returned invalid JSON: ${stdout}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(`Failed to spawn variational-ai-cli: ${err.message}`));
      }
    });

    // Write the request JSON to the CLI's stdin and close the pipe.
    proc.stdin.write(json);
    proc.stdin.end();
  });
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
 * Call the Rust CLI to scan a set of live DEX pool snapshots for profitable
 * arbitrage cycles (Bellman-Ford negative-cycle detection + variational
 * stationary-point trade sizing).
 *
 * @param req  Pool snapshots + solver params (see ArbitrageOpportunitiesRequest).
 * @param timeoutMs  Kill the subprocess if it takes longer (default: 30 s).
 */
export async function findArbitrageOpportunities(
  req: ArbitrageOpportunitiesRequest,
  timeoutMs = 30_000,
): Promise<ArbitrageOpportunitiesResponse> {
  const json = JSON.stringify(req);
  return new Promise((resolve, reject) => {
    const proc = spawn(ARBITRAGE_CLI_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
      reject(new Error(`variational-ai-arbitrage-cli timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return; // already rejected

      if (code === 2) {
        return reject(new Error(`variational-ai-arbitrage-cli error: ${stderr.trim() || stdout.trim()}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim()) as ArbitrageOpportunitiesResponse;
        resolve(parsed);
      } catch (e) {
        reject(new Error(`variational-ai-arbitrage-cli returned invalid JSON: ${stdout}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut) {
        reject(new Error(`Failed to spawn variational-ai-arbitrage-cli: ${err.message}`));
      }
    });

    proc.stdin.write(json);
    proc.stdin.end();
  });
}
