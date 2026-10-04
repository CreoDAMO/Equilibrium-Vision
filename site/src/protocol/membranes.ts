import { merkleRoot, sha256Hex } from "./crypto";
import { solveStationary, type SolveInput, type SolverHeader, type SolverState } from "./solver";
import type { Couplings } from "./types";

/**
 * Four membranes. None of them is a second successor.
 * A proof is a commitment G recomputes. A phone is a local organ.
 * Temperature and peers are not canonical state.
 */

export function residualBinding(residualFp: number, stateRoot: string): string {
  return sha256Hex(`eq-bind|${residualFp}|${stateRoot}`);
}

export function modelBinding(
  chainId: number,
  claim: { id: number; uri: string; residualFp: number; supportHash: string },
): string {
  return sha256Hex(
    `eq-model|${chainId}|${claim.id}|${claim.uri}|${claim.residualFp}|${claim.supportHash}`,
  );
}

export function challengeBinding(chainId: number, id: number, supportHash: string): string {
  return sha256Hex(`eq-challenge|${chainId}|${id}|${supportHash}`);
}

export interface DeviceResources {
  thermalC: number;
  battery: number;
}

/** Local participation. This does not enter I. */
export function participation(resources: DeviceResources): "solve" | "verify" | "defer" {
  if (!Number.isFinite(resources.thermalC) || !Number.isFinite(resources.battery)) return "defer";
  if (resources.thermalC >= 42 || resources.battery < 0.15) return "defer";
  if (resources.thermalC >= 38 || resources.battery < 0.4) return "verify";
  return "solve";
}

/**
 * The phone may search. The result is a candidate, not Ω′.
 * A deferred or verifying device does not search.
 */
export function mobileCandidate(
  input: SolveInput,
  resources: DeviceResources,
): { mode: "defer" | "verify" } | { mode: "solve"; nonce: number; residualFp: number } {
  const mode = participation(resources);
  if (mode !== "solve") return { mode };
  const solved = solveStationary(input);
  return { mode: "solve", nonce: solved.nonce, residualFp: solved.residualFp };
}

/**
 * The phone's candidate carries the same transaction identity production seals.
 * A placeholder merkle root is not I. The candidate is still not Ω′.
 */
export function bindMobileCandidate(
  header: Omit<SolverHeader, "merkleRoot">,
  txs: { hash: string; fee: number }[],
  state: SolverState,
  couplings: Couplings | undefined,
  resources: DeviceResources,
): { mode: "defer" | "verify" } | { mode: "solve"; nonce: number; residualFp: number; merkleRoot: string } {
  const merkleRootHex = merkleRoot(txs.length ? txs.map((t) => t.hash) : ["0".repeat(64)]);
  const solved = mobileCandidate(
    { header: { ...header, merkleRoot: merkleRootHex }, txs, state, couplings },
    resources,
  );
  if (solved.mode !== "solve") return solved;
  return { mode: "solve", nonce: solved.nonce, residualFp: solved.residualFp, merkleRoot: merkleRootHex };
}

export interface MobilePeer {
  id: string;
  multiaddr: string;
  via: "qr" | "nfc";
}

export interface PeerBook {
  peers: MobilePeer[];
}

const BOOTSTRAP = /^eq1:(qr|nfc):([0-9a-f]{16})@(\S+)$/;

export function bootstrapCode(peer: MobilePeer): string {
  return `eq1:${peer.via}:${peer.id}@${peer.multiaddr}`;
}

/** QR and NFC carry the same string. The radio is not a different protocol. */
export function parseBootstrap(text: string): MobilePeer | null {
  const match = BOOTSTRAP.exec(text.trim());
  if (!match) return null;
  const via = match[1] === "nfc" ? "nfc" : "qr";
  return { via, id: match[2]!, multiaddr: match[3]! };
}

export function remember(book: PeerBook, peer: MobilePeer): PeerBook {
  return { peers: [...book.peers.filter((p) => p.id !== peer.id), peer] };
}

export function persistPeers(book: PeerBook): string {
  return JSON.stringify({
    peers: book.peers.map((p) => ({ id: p.id, multiaddr: p.multiaddr, via: p.via })),
  });
}

/** A dead process. The book is the only thing that comes back. */
export function restorePeers(raw: string): PeerBook {
  try {
    const parsed = JSON.parse(raw) as { peers?: unknown };
    if (!Array.isArray(parsed.peers)) return { peers: [] };
    const peers: MobilePeer[] = [];
    for (const row of parsed.peers) {
      if (!row || typeof row !== "object") continue;
      const peer = row as { id?: unknown; multiaddr?: unknown; via?: unknown };
      if (typeof peer.id !== "string" || typeof peer.multiaddr !== "string") continue;
      if (peer.via !== "qr" && peer.via !== "nfc") continue;
      if (!/^[0-9a-f]{16}$/.test(peer.id)) continue;
      peers.push({ id: peer.id, multiaddr: peer.multiaddr, via: peer.via });
    }
    return { peers };
  } catch {
    return { peers: [] };
  }
}
