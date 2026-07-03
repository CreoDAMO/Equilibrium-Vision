import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import { generateZkProof, verifyZkProof, fpEncode, encodeBlockHash, type ZkProof } from "./zkproof.js";

// ── Rust consensus-api sidecar bridge ────────────────────────────────────────
//
// Connects to the Rust consensus-api binary via stdin/stdout JSON-RPC.
// Falls back to the TypeScript zkproof implementation when unavailable.
//
// Build the sidecar:
//   cd equilibrium && cargo build --release --bin consensus-api
//
// The binary is expected at:
//   equilibrium/target/release/consensus-api
//
// The bridge is optional — the TypeScript stack runs without it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_PATH = path.resolve(__dirname, "../../../../../equilibrium/target/release/consensus-api");

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject:  (e: Error) => void;
  timer:   NodeJS.Timeout;
}

class ConsensusBridge {
  private proc:    ChildProcess | null = null;
  private ready:   boolean = false;
  private queue:   PendingRequest[] = [];
  private pending: Map<string, PendingRequest> = new Map();
  private seq:     number = 0;
  private tryCount = 0;

  constructor() {
    this.trySpawn();
  }

  private trySpawn() {
    this.tryCount++;
    try {
      const proc = spawn(SIDECAR_PATH, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.on("error", (err) => {
        if (this.tryCount === 1) {
          logger.warn({ sidecar: SIDECAR_PATH, err: err.message },
            "Rust consensus-api not available — using TypeScript fallback. " +
            "Run `cd equilibrium && cargo build --release --bin consensus-api` to enable it.");
        }
        this.proc = null;
        this.ready = false;
      });

      proc.on("exit", (code) => {
        logger.warn({ code }, "consensus-api sidecar exited");
        this.proc  = null;
        this.ready = false;
      });

      // Parse newline-delimited JSON responses
      const rl = createInterface({ input: proc.stdout! });
      rl.on("line", (line) => {
        try {
          const res = JSON.parse(line) as { _seq?: string } & Record<string, unknown>;
          const seq = res._seq;
          if (seq && this.pending.has(seq)) {
            const req = this.pending.get(seq)!;
            this.pending.delete(seq);
            clearTimeout(req.timer);
            if (res.ok === false) req.reject(new Error(String(res.error ?? "unknown")));
            else req.resolve(res);
          }
        } catch {}
      });

      proc.stderr?.on("data", (d: Buffer) => {
        const msg = d.toString().trim();
        if (msg) logger.debug({ sidecar: "consensus-api" }, msg);
      });

      // Warmup request to trigger key generation
      this.proc = proc;
      this.sendRaw({ method: "warmup" })
        .then(() => {
          this.ready = true;
          logger.info({ sidecar: SIDECAR_PATH }, "Rust consensus-api sidecar connected");
          // Flush any queued requests
          while (this.queue.length > 0) {
            const pending = this.queue.shift()!;
            pending.resolve(undefined); // will be re-sent by caller
          }
        })
        .catch(() => {
          this.ready = false;
        });
    } catch {
      // spawn itself threw (binary missing)
      this.proc  = null;
      this.ready = false;
    }
  }

  private sendRaw(req: object, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc) { reject(new Error("sidecar not running")); return; }

      const id    = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("sidecar timeout"));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ ...req, _seq: id }) + "\n";
      this.proc.stdin!.write(line);
    });
  }

  /** Whether the Rust sidecar is available and warmed up. */
  get isAvailable(): boolean {
    return this.ready && this.proc !== null;
  }

  /** Generate a real Groth16 proof via the Rust sidecar (falls back to TS). */
  async prove(residual: number, blockHash: string, height: number, threshold = 1e-7): Promise<ZkProof> {
    if (!this.isAvailable) {
      return generateZkProof(residual, blockHash, height, threshold);
    }
    try {
      const res = await this.sendRaw({
        method: "prove", residual, threshold, blockHash, height,
      }) as Record<string, unknown>;
      // Reconstruct public inputs deterministically from request args using the
      // same encoding as zkproof.ts — the Rust sidecar only returns
      // { ok, proof, vkHash, circuitId, provedAt } and does not echo them back.
      const { blockHashLow, blockHashHigh } = encodeBlockHash(blockHash);
      return {
        proof:        res["proof"] as ZkProof["proof"],
        publicInputs: {
          residual:  fpEncode(residual),
          threshold: fpEncode(threshold),
          blockHashLow,
          blockHashHigh,
        },
        vkHash:    String(res["vkHash"] ?? ""),
        valid:     Boolean(res["valid"]),
        provedAt:  Number(res["provedAt"] ?? 0),
        circuitId: String(res["circuitId"] ?? ""),
      };
    } catch (err) {
      logger.warn({ err }, "sidecar prove failed, falling back to TS");
      return generateZkProof(residual, blockHash, height, threshold);
    }
  }

  /** Verify a proof via the Rust sidecar (falls back to TS). */
  async verify(zkp: ZkProof, threshold = 1e-7): Promise<boolean> {
    if (!this.isAvailable) {
      return verifyZkProof(zkp, threshold);
    }
    try {
      // Reconstruct the 32-hex-char block hash prefix that was bound at prove time.
      // encodeBlockHash stores blockHash.slice(0, 32) as blockHashLow (≤128 bits,
      // so blockHashHigh is always 0).  Reversing: low → 32 hex chars, pad to 64.
      const blockHashPrefix = BigInt(zkp.publicInputs.blockHashLow)
        .toString(16)
        .padStart(32, "0");
      const blockHash = blockHashPrefix + "0".repeat(32);

      const res = await this.sendRaw({
        method: "verify",
        proof: zkp.proof,
        residual: Number(BigInt(zkp.publicInputs.residual)) / 1e18,
        threshold,
        blockHash,
      }) as Record<string, unknown>;
      return Boolean(res["valid"]);
    } catch {
      return verifyZkProof(zkp, threshold);
    }
  }

  /** Run the Rust StationarySolver for block mining (falls back silently if unavailable). */
  async solve(params: {
    prevHash:        string;
    merkleRoot:      string;
    timestamp:       number;
    difficulty:      number;
    maxIter?:        number;
    mempoolPressure?: number;
    cumulativeWork?: number;
  }): Promise<{ nonce: number; residual: number } | null> {
    if (!this.isAvailable) return null;
    try {
      const res = await this.sendRaw({ method: "solve", ...params }, 60_000) as Record<string, unknown>;
      return { nonce: Number(res["nonce"]), residual: Number(res["residual"]) };
    } catch {
      return null;
    }
  }

  shutdown() {
    this.proc?.kill();
    this.proc  = null;
    this.ready = false;
  }
}

/** Singleton bridge instance (created once on first import). */
export const consensusBridge = new ConsensusBridge();
