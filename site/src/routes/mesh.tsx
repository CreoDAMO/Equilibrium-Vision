import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listMeshLog, recordMeshSighting } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { useP2PRoom } from "@/lib/multiplayer/use-p2p-room";
import { independentVerify } from "@/protocol/light";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatSci, truncateHash } from "@/lib/format";

export const Route = createFileRoute("/mesh")({ component: MeshPage });

interface Gossip {
  kind: "header";
  hash: string;
  height: number;
  residual: number;
}

function MeshPage() {
  const { network, snap } = useNetwork();
  const room = `eq-${network}`;
  const { onMessage, broadcast, selfId, peers, joined } = useP2PRoom({ room, name: "light" });
  const qc = useQueryClient();
  const log = useQuery({
    queryKey: ["mesh", network],
    queryFn: () => listMeshLog({ data: { network } }),
    refetchInterval: 4000,
  });
  const [last, setLast] = useState<string>("Waiting for a header.");

  useEffect(() => {
    return onMessage((from, data) => {
      const msg = data as Gossip;
      if (!msg || msg.kind !== "header" || !snap) return;
      const block = snap.recentBlocks.find((b) => b.hash === msg.hash);
      const prev = block ? snap.recentBlocks.find((b) => b.hash === block.prevHash) ?? null : null;
      if (!block) {
        setLast(`${from.slice(0, 8)} sent h=${msg.height} — not in this body’s recent window`);
        void recordMeshSighting({
          data: {
            network,
            peerId: from,
            height: msg.height,
            hash: msg.hash,
            agree: false,
            detail: "header not in local window",
          },
        }).then(() => qc.invalidateQueries({ queryKey: ["mesh", network] }));
        return;
      }
      const report = independentVerify(block, prev, snap.params);
      const residualLie = Math.abs(msg.residual - report.localResidual) > 1e-9;
      const agree = report.agree && !residualLie;
      setLast(
        `${from.slice(0, 8)} · #${block.height} · ${agree ? "recompute agrees" : "rejected"} · R ${formatSci(report.localResidual, 2)}`,
      );
      void recordMeshSighting({
        data: {
          network,
          peerId: from,
          height: block.height,
          hash: block.hash,
          agree,
          detail: agree ? "independent verify" : residualLie ? "claimed residual mismatch" : "verify failed",
        },
      }).then(() => qc.invalidateQueries({ queryKey: ["mesh", network] }));
    });
  }, [onMessage, snap, network, qc]);

  const publish = () => {
    const tip = snap?.recentBlocks[0];
    if (!tip || !snap) return;
    const prev = snap.recentBlocks.find((b) => b.hash === tip.prevHash) ?? null;
    const report = independentVerify(tip, prev, snap.params);
    const packet: Gossip = { kind: "header", hash: tip.hash, height: tip.height, residual: tip.residual };
    broadcast(packet);
    void recordMeshSighting({
      data: {
        network,
        peerId: selfId,
        height: tip.height,
        hash: tip.hash,
        agree: report.agree,
        detail: "local publish",
      },
    }).then(() => qc.invalidateQueries({ queryKey: ["mesh", network] }));
    setLast(`Published #${tip.height} to room ${room}`);
  };

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Mesh</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Browser peers exchange headers over WebRTC. Each receiver recomputes. The Rust libp2p
          sidecar is still only a source body — this page does not pretend to be that swarm.
          One open tab is a mesh of one. A second tab is an edge.
        </p>
      </header>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-subtle">Room {room}</p>
            <p className="mt-1 font-mono text-sm">{joined ? selfId : "joining…"}</p>
          </div>
          <Button onClick={publish} disabled={!snap}>
            Publish tip
          </Button>
        </div>
        <p className="mt-4 text-sm text-muted">{last}</p>
        <ul className="mt-4 space-y-2">
          {peers.length === 0 ? (
            <li className="text-sm text-muted">No remote peer yet. Open Mesh in another browser on the same network.</li>
          ) : (
            peers.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="font-mono">{p.id}</span>
                <span className="text-muted">
                  {p.connectionState}
                  {p.rttMs != null ? ` · ${p.rttMs} ms` : ""}
                  {p.candidateType ? ` · ${p.candidateType}` : ""}
                </span>
              </li>
            ))
          )}
        </ul>
      </div>

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">Sightings</h2>
        <ul className="mt-3 divide-y divide-border">
          {(log.data ?? []).map((row) => (
            <li key={row.id} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div>
                <div className="font-mono">{row.peer_id}</div>
                <div className="text-xs text-muted">
                  #{row.height} · {truncateHash(row.hash)} · {row.detail}
                </div>
              </div>
              <Badge tone={row.agree ? "ok" : "danger"}>{row.agree ? "agree" : "reject"}</Badge>
            </li>
          ))}
          {log.data && log.data.length === 0 ? <li className="py-3 text-sm text-muted">No sightings stored.</li> : null}
        </ul>
      </section>
    </div>
  );
}
