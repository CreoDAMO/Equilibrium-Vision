/**
 * p2p-mesh.integration.test.ts
 *
 * Verifies that the compiled p2p-sidecar binary can start, listen, respond to
 * JSON-RPC commands, and — when two instances are spawned — exchange a gossiped
 * block hash via Gossipsub.
 *
 * The tests are automatically SKIPPED when the sidecar binary is not built, so
 * they are safe to run on any machine and in CI without the binary present.
 * To include them in CI, add a build step:
 *
 *   - name: Build p2p-sidecar
 *     run: cargo build --release --bin p2p-sidecar
 *     working-directory: equilibrium
 *
 * Set P2P_SIDECAR_PATH to override the default binary location.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ChildProcess, spawn } from "child_process";
import { createConnection, Socket } from "net";
import { existsSync } from "fs";
import { resolve } from "path";

// ── Binary location ────────────────────────────────────────────────────────────

const SIDECAR_BIN =
  process.env["P2P_SIDECAR_PATH"] ??
  resolve(process.cwd(), "../../equilibrium/target/release/p2p-sidecar");

const binPresent = existsSync(SIDECAR_BIN);

// ── Helpers ────────────────────────────────────────────────────────────────────

function pickPort(): number {
  // Return a port in the ephemeral range that is likely free.
  return 40000 + Math.floor(Math.random() * 10000);
}

/** Start a sidecar process on the given port and return the child + a cleanup fn. */
function startSidecar(
  tcpPort: number,
  quicPort: number,
  bootstrapAddr?: string,
): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P2P_PORT: String(tcpPort),
    P2P_QUIC_PORT: String(quicPort),
  };
  if (bootstrapAddr) env["P2P_BOOTSTRAP"] = bootstrapAddr;

  return spawn(SIDECAR_BIN, [], { env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Send a JSON-RPC request to the sidecar's stdin and read one JSON line back. */
function rpcCall(
  proc: ChildProcess,
  request: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("rpcCall timed out")),
      timeoutMs,
    );

    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const newline = buf.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        proc.stdout!.off("data", onData);
        try {
          resolve(JSON.parse(buf.slice(0, newline)));
        } catch (e) {
          reject(e);
        }
      }
    };

    proc.stdout!.on("data", onData);
    proc.stdin!.write(JSON.stringify(request) + "\n");
  });
}

/** Wait for the sidecar's stderr to emit a line containing `token`. */
function waitForLog(proc: ChildProcess, token: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`waitForLog("${token}") timed out`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(token)) {
        clearTimeout(timer);
        proc.stderr!.off("data", onData);
        resolve();
      }
    };
    proc.stderr!.on("data", onData);
  });
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!binPresent)("p2p-sidecar mesh (binary required)", () => {
  let proc1: ChildProcess;
  let proc2: ChildProcess;
  const port1 = pickPort();
  const quic1 = port1 + 1;
  const port2 = pickPort() + 200; // offset to avoid collision
  const quic2 = port2 + 1;

  afterAll(async () => {
    proc1?.kill("SIGTERM");
    proc2?.kill("SIGTERM");
    // Give processes a moment to exit cleanly.
    await new Promise((r) => setTimeout(r, 200));
  });

  // ── Single-node smoke test ─────────────────────────────────────────────────

  it("starts and reports listen_addrs", async () => {
    proc1 = startSidecar(port1, quic1);
    // Wait for the sidecar to bind its TCP listener (logs "Listening on ...")
    await waitForLog(proc1, "Listening on", 8000);

    const resp = await rpcCall(proc1, { id: "1", method: "listen_addrs" });
    expect(resp).toMatchObject({ ok: true });
    expect(Array.isArray((resp as any).addrs)).toBe(true);
    expect((resp as any).addrs.length).toBeGreaterThan(0);
  }, 15_000);

  it("reports peer_id as a non-empty string", async () => {
    const resp = await rpcCall(proc1, { id: "2", method: "peer_id" });
    expect(resp).toMatchObject({ ok: true });
    expect(typeof (resp as any).peer_id).toBe("string");
    expect((resp as any).peer_id.length).toBeGreaterThan(0);
  }, 10_000);

  // ── Two-node gossip test ──────────────────────────────────────────────────

  it("node2 receives a gossiped block hash from node1", async () => {
    // Get node1's listen addr so node2 can bootstrap to it.
    const addrResp = await rpcCall(proc1, { id: "3", method: "listen_addrs" });
    const addrs = (addrResp as any).addrs as string[];
    // Prefer TCP addr for reliability.
    const bootstrap = addrs.find((a) => a.includes("/tcp/")) ?? addrs[0];
    expect(bootstrap).toBeDefined();

    // Start node2, bootstrapping to node1.
    proc2 = startSidecar(port2, quic2, bootstrap);
    await waitForLog(proc2, "Listening on", 8000);

    // Give the two peers time to discover each other via Kademlia/mDNS.
    await waitForLog(proc2, "ConnectionEstablished", 8000).catch(() => {
      // mDNS may not work in CI — just wait a fixed interval instead.
      return new Promise((r) => setTimeout(r, 2000));
    });

    // Subscribe both nodes to the blocks topic (if not already subscribed at start).
    await rpcCall(proc2, { id: "4", method: "subscribe", topic: "blocks" }).catch(() => {});

    // Gossip a fake hash from node1.
    const fakeHash = "deadbeef".repeat(8);
    const gossipResp = await rpcCall(proc1, {
      id: "5",
      method: "gossip_block",
      hash: fakeHash,
    });
    expect(gossipResp).toMatchObject({ ok: true });

    // Poll node2 for the received hash (with retries).
    let received: string | undefined;
    for (let i = 0; i < 20; i++) {
      const poll = await rpcCall(proc2, { id: `poll-${i}`, method: "poll_gossip" });
      if ((poll as any).hash === fakeHash) {
        received = (poll as any).hash;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(received).toBe(fakeHash);
  }, 30_000);
});

// ── Informational test that always runs ───────────────────────────────────────

describe("p2p-sidecar binary presence", () => {
  it("reports whether the binary is available", () => {
    if (!binPresent) {
      console.info(
        `[p2p-mesh] Sidecar binary not found at ${SIDECAR_BIN}.\n` +
        `Run: cd equilibrium && cargo build --release --bin p2p-sidecar\n` +
        `Or set P2P_SIDECAR_PATH env var. Mesh tests are SKIPPED.`,
      );
    }
    // Always pass — this is an informational test only.
    expect(true).toBe(true);
  });
});
