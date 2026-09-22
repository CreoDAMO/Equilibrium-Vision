import { createFileRoute, Link } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { formatAmount, truncateHash } from "@/lib/format";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/mempool")({ component: MempoolPage });

function MempoolPage() {
  const { snap } = useNetwork();
  if (!snap) return <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-6">
      <h1 className="font-display text-4xl tracking-tight">Mempool</h1>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Size" value={snap.mempoolSize} hint="cap 500" />
        <Stat label="Pressure" value={snap.mempoolPressure.toFixed(3)} hint="P = min(|M|/500, 1)" />
      </div>
      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <ul className="divide-y divide-border">
          {snap.mempool.length === 0 ? (
            <li className="py-3 text-sm text-muted">Empty. The next solve will see P ≈ 0.</li>
          ) : (
            snap.mempool.map((t) => (
              <li key={t.hash} className="flex justify-between py-3 text-sm">
                <Link className="font-mono text-accent" to="/tx/$hash" params={{ hash: t.hash }}>
                  {truncateHash(t.hash)}
                </Link>
                <span className="font-mono text-muted">fee {formatAmount(t.fee)}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
