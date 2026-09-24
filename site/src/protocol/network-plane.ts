import type { BlockRecord } from "./types";

/**
 * The network plane delivers candidates. Rust libp2p, when the sidecar
 * binary is present, is this same plane: it may speak hashes and ask for
 * bodies. It is not given a chain. A hash alone is refused. A body is
 * admitted only by the organism's existing transition.
 */
export interface PlaneEvent {
  event: "block" | "tx" | "peer_connected";
  peerId: string;
  blockHash?: string;
  txHash?: string;
}

export interface CanonicalPort {
  hasBlock(hash: string): boolean;
  admit(block: BlockRecord): { ok: boolean; error?: string };
}

export function onPlaneMessage(
  port: CanonicalPort,
  event: PlaneEvent,
  body?: BlockRecord,
): { ok: boolean; error?: string; duplicate?: boolean } {
  if (event.event !== "block") return { ok: true };
  if (!event.blockHash) return { ok: false, error: "block event without a hash" };
  if (port.hasBlock(event.blockHash)) return { ok: true, duplicate: true };
  if (!body) return { ok: false, error: "a hash is not a block" };
  if (body.hash !== event.blockHash) return { ok: false, error: "body does not match the announced hash" };
  return port.admit(body);
}
