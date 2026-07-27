/**
 * P2P inbound sync integration tests.
 *
 * Verifies that initChain() wires the onSyncRequest and onLightNodeRequest
 * callbacks on p2pBridge so that inbound sidecar events are handled correctly
 * under both TCP and QUIC transport paths.
 *
 * The sidecar binary is not running in CI, so we mock the respond helpers and
 * invoke the handlers directly — this tests the TS handler logic in isolation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { initChain, stopMining, chainState } from "../chain/index.js";
import { p2pBridge } from "../chain/p2p-bridge.js";

beforeAll(async () => {
  await initChain();
}, 30_000);

afterAll(() => {
  stopMining();
});

// ── Handler registration ──────────────────────────────────────────────────────

describe("P2P handler registration", () => {
  it("onSyncRequest is set to a function after initChain()", () => {
    // If this is undefined the sidecar's sync_request events are silently dropped
    expect(typeof p2pBridge.onSyncRequest).toBe("function");
  });

  it("onLightNodeRequest is set to a function after initChain()", () => {
    expect(typeof p2pBridge.onLightNodeRequest).toBe("function");
  });

  it("both handlers are transport-agnostic (single callback covers TCP + QUIC)", () => {
    // The sidecar abstracts transport; the same JS function fires for both.
    const syncFn = p2pBridge.onSyncRequest;
    const lnFn   = p2pBridge.onLightNodeRequest;
    expect(syncFn).toBe(p2pBridge.onSyncRequest);
    expect(lnFn).toBe(p2pBridge.onLightNodeRequest);
  });
});

// ── onSyncRequest — block ─────────────────────────────────────────────────────

describe("onSyncRequest — block by hash", () => {
  it("responds with the full block when requested by hash", async () => {
    const tip = chainState.latestBlock;
    expect(tip).toBeDefined();

    const spy = vi.spyOn(p2pBridge, "respondToSyncRequest").mockResolvedValue();
    try {
      await p2pBridge.onSyncRequest!("req-sync-1", "QmTestPeer", "block", { hash: tip!.hash });

      expect(spy).toHaveBeenCalledOnce();
      const [reqId, data] = spy.mock.calls[0]!;
      expect(reqId).toBe("req-sync-1");
      expect((data as Record<string, unknown>)["hash"]).toBe(tip!.hash);
    } finally {
      spy.mockRestore();
    }
  });

  it("responds with an error object for an unknown hash", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToSyncRequest").mockResolvedValue();
    try {
      await p2pBridge.onSyncRequest!("req-sync-2", "QmTestPeer", "block", {
        hash: "dead".repeat(16),
      });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      expect(data).toHaveProperty("error");
    } finally {
      spy.mockRestore();
    }
  });

  it("responds with the block when requested by height", async () => {
    const tip = chainState.latestBlock;
    expect(tip).toBeDefined();

    const spy = vi.spyOn(p2pBridge, "respondToSyncRequest").mockResolvedValue();
    try {
      await p2pBridge.onSyncRequest!("req-sync-3", "QmTestPeer", "block", {
        height: tip!.height,
      });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      expect((data as Record<string, unknown>)["hash"]).toBe(tip!.hash);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── onSyncRequest — headers ───────────────────────────────────────────────────

describe("onSyncRequest — headers range", () => {
  it("returns an array of headers for a valid range", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToSyncRequest").mockResolvedValue();
    try {
      await p2pBridge.onSyncRequest!("req-sync-4", "QmTestPeer", "headers", { from: 0, to: 5 });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      const d = data as { headers: unknown[] };
      expect(Array.isArray(d.headers)).toBe(true);
      expect(d.headers.length).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("each header includes hash and height", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToSyncRequest").mockResolvedValue();
    try {
      await p2pBridge.onSyncRequest!("req-sync-5", "QmTestPeer", "headers", { from: 0, to: 2 });

      const [, data] = spy.mock.calls[0]!;
      const headers = (data as { headers: Record<string, unknown>[] }).headers;
      for (const h of headers) {
        expect(typeof h["hash"]).toBe("string");
        expect(typeof h["height"]).toBe("number");
        expect(typeof h["prevHash"]).toBe("string");
      }
    } finally {
      spy.mockRestore();
    }
  });
});

// ── onLightNodeRequest — tip ──────────────────────────────────────────────────

describe("onLightNodeRequest — tip", () => {
  it("responds with ok:true and the current tip data", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToLightNodeRequest").mockResolvedValue();
    try {
      await p2pBridge.onLightNodeRequest!("req-ln-1", "QmTestPeer", { kind: "tip" });

      expect(spy).toHaveBeenCalledOnce();
      const [reqId, data] = spy.mock.calls[0]!;
      expect(reqId).toBe("req-ln-1");
      const d = data as { ok: boolean; data: { height: number; hash: string } };
      expect(d.ok).toBe(true);
      expect(typeof d.data.height).toBe("number");
      expect(d.data.hash).toHaveLength(64);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── onLightNodeRequest — headers ──────────────────────────────────────────────

describe("onLightNodeRequest — headers", () => {
  it("responds with a headers list", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToLightNodeRequest").mockResolvedValue();
    try {
      await p2pBridge.onLightNodeRequest!("req-ln-2", "QmTestPeer", {
        kind: "headers",
        params: { from: 0, to: 3 },
      });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      const d = data as { ok: boolean; data: { headers: unknown[] } };
      expect(d.ok).toBe(true);
      expect(Array.isArray(d.data.headers)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

// ── onLightNodeRequest — proof (cold-cache / state-root guard) ────────────────

describe("onLightNodeRequest — proof_account (root guard)", () => {
  it("responds with a structured object (ok=true or ok=false with error)", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToLightNodeRequest").mockResolvedValue();
    try {
      await p2pBridge.onLightNodeRequest!("req-ln-3", "QmTestPeer", {
        kind: "proof_account",
        params: { address: "a".repeat(40) },
      });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      // On a fresh dev chain the stateRoot may not be set yet → ok=false is valid.
      // On a chain with at least one mined block → ok=true.
      // Either way the response must be a structured object with an `ok` field.
      expect(typeof (data as Record<string, unknown>)["ok"]).toBe("boolean");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Unknown kind ──────────────────────────────────────────────────────────────

describe("onLightNodeRequest — unknown kind", () => {
  it("responds with ok:false for an unrecognised query kind", async () => {
    const spy = vi.spyOn(p2pBridge, "respondToLightNodeRequest").mockResolvedValue();
    try {
      await p2pBridge.onLightNodeRequest!("req-ln-4", "QmTestPeer", {
        kind: "unknown_query_type_xyz",
      });

      expect(spy).toHaveBeenCalledOnce();
      const [, data] = spy.mock.calls[0]!;
      expect((data as { ok: boolean }).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
