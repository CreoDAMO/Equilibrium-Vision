import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { OrganismNode } from "@/protocol/chain";
import type { BlockRecord, NetworkId } from "@/protocol/types";

/**
 * Rust libp2p is a mouth and an ear of one organism.
 *
 * One process, one network (P2P_NETWORK, default testnet). It may announce
 * a hash, carry a body, and mirror the tip after this process commits.
 * It is not given mine(), and it is not asked to adopt. A hash is not a
 * block. A body becomes state only through deliverFromPeer.
 */
export function attachSidecar(getNode: (network: NetworkId) => OrganismNode | undefined): ChildProcess | null {
  const bin = process.env.P2P_SIDECAR;
  if (!bin || !existsSync(bin)) return null;
  const network: NetworkId = process.env.P2P_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<string, { peerId: string; hash: string }>();
  let seq = 0;
  const nextId = () => `eq-${seq++}`;

  const node = () => getNode(network);
  const initial = node();
  if (initial) initial.onCommitted((block) => mirror(child, nextId, block));

  lines.on("line", (line) => {
    let msg: SidecarLine;
    try {
      msg = JSON.parse(line) as SidecarLine;
    } catch {
      return;
    }
    const current = node();
    if (!current) return;

    if (msg.id && waiting.has(msg.id)) {
      if (msg.pending) return;
      const wait = waiting.get(msg.id)!;
      waiting.delete(msg.id);
      const body = asBlock(msg.data);
      if (msg.ok && body && body.hash === wait.hash) current.deliverFromPeer(wait.peerId, body);
      return;
    }

    if (msg.event === "block" && msg.blockHash && msg.peerId) {
      current.noteAnnouncement(msg.blockHash);
      if (current.getBlock(msg.blockHash)) return;
      const id = nextId();
      waiting.set(id, { peerId: msg.peerId, hash: msg.blockHash });
      write(child, {
        id,
        method: "query_sync",
        peerId: msg.peerId,
        query: { kind: "block", params: { hash: msg.blockHash } },
      });
      return;
    }

    if (msg.event === "block_body" && msg.peerId) {
      const body = asBlock(msg.body);
      if (body) current.deliverFromPeer(msg.peerId, body);
      return;
    }

    if (msg.event === "lightnode_request" && msg.query?.kind === "tip") {
      const tip = current.tip;
      write(child, {
        method: "lightnode_response",
        requestId: msg.requestId,
        ok: Boolean(tip),
        data: tip ? { hash: tip.hash, height: tip.height, stateRoot: tip.stateRoot, difficulty: tip.difficulty } : null,
      });
      return;
    }

    if (msg.event === "sync_request" && msg.query?.kind === "block") {
      const hash = msg.query.params?.hash;
      const block = hash ? current.getBlock(hash) : undefined;
      write(child, {
        method: "sync_response",
        requestId: msg.requestId,
        ok: Boolean(block),
        data: block ?? null,
      });
    }
  });

  child.on("exit", (code) => {
    console.error(`[p2p] sidecar exited ${code ?? "unknown"}. The organism keeps the chain.`);
  });
  return child;
}

function mirror(child: ChildProcess, nextId: () => string, block: BlockRecord) {
  write(child, { id: nextId(), method: "set_local_tip", height: block.height, hash: block.hash, difficulty: block.difficulty });
  write(child, { id: nextId(), method: "gossip_block", blockHash: block.hash });
  write(child, { id: nextId(), method: "gossip_block_body", body: block });
}

function asBlock(value: unknown): BlockRecord | null {
  if (!value || typeof value !== "object") return null;
  const hash = (value as { hash?: unknown }).hash;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  return value as BlockRecord;
}

type SidecarLine = {
  event?: string;
  blockHash?: string;
  peerId?: string;
  requestId?: string;
  id?: string;
  ok?: boolean;
  pending?: boolean;
  data?: unknown;
  body?: unknown;
  query?: { kind?: string; params?: { hash?: string } };
};

function write(child: ChildProcess, body: unknown) {
  child.stdin?.write(`${JSON.stringify(body)}\n`);
}
