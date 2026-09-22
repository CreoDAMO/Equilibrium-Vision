import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getTx } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { formatAmount, formatTime, truncateHash } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/tx/$hash")({ component: TxDetail });

function TxDetail() {
  const { hash } = Route.useParams();
  const { network } = useNetwork();
  const { data: tx } = useQuery({
    queryKey: ["tx", network, hash],
    queryFn: () => getTx({ data: { network, hash } }),
  });
  if (!tx) return <p className="text-muted">Transaction not found.</p>;
  return (
    <div className="space-y-6">
      <h1 className="break-all font-mono text-lg">{tx.hash}</h1>
      <Badge tone={tx.status === "confirmed" ? "ok" : "warn"}>{tx.status}</Badge>
      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] text-sm space-y-3">
        <Row k="From" v={<Link className="text-accent font-mono" to="/address/$addr" params={{ addr: tx.from }}>{truncateHash(tx.from)}</Link>} />
        <Row k="To" v={<Link className="text-accent font-mono" to="/address/$addr" params={{ addr: tx.to }}>{truncateHash(tx.to)}</Link>} />
        <Row k="Amount" v={formatAmount(tx.amount)} />
        <Row k="Fee" v={formatAmount(tx.fee)} />
        <Row k="Nonce" v={String(tx.nonce)} />
        <Row k="Time" v={formatTime(tx.timestamp)} />
        {tx.blockHash ? (
          <Row k="Block" v={<Link className="text-accent font-mono" to="/blocks/$hash" params={{ hash: tx.blockHash }}>{truncateHash(tx.blockHash)}</Link>} />
        ) : null}
      </div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
