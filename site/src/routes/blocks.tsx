import { createFileRoute } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { HashLink } from "@/components/hash-link";
import { formatAmount, formatSci, timeAgo } from "@/lib/format";

export const Route = createFileRoute("/blocks")({ component: Blocks });

function Blocks() {
  const { snap } = useNetwork();
  if (!snap) return <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-6">
      <h1 className="font-display text-4xl tracking-tight">Blocks</h1>
      <div className="overflow-x-auto rounded-xl bg-surface shadow-[var(--shadow-border)]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-subtle">
            <tr>
              {["Height", "Hash", "Tx", "Residual", "Reward", "When"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snap.recentBlocks.map((b) => (
              <tr key={b.hash} className="border-t border-border">
                <td className="px-4 py-3 font-mono tabular">{b.height}</td>
                <td className="px-4 py-3">
                  <HashLink kind="block" value={b.hash} />
                </td>
                <td className="px-4 py-3">{b.txCount}</td>
                <td className="px-4 py-3 font-mono">{formatSci(b.residual, 2)}</td>
                <td className="px-4 py-3 font-mono">{formatAmount(b.coinbaseReward)}</td>
                <td className="px-4 py-3 text-muted">{timeAgo(b.timestamp)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
