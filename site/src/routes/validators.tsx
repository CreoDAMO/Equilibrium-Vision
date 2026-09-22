import { createFileRoute, Link } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { formatAmount, truncateHash } from "@/lib/format";

export const Route = createFileRoute("/validators")({ component: Validators });

function Validators() {
  const { snap } = useNetwork();
  if (!snap) return <p className="text-muted">Loading…</p>;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Validators</h1>
        <p className="mt-2 max-w-xl text-muted">
          Finality is a 2/3 bonded-stake vote. It is not stationarity. Genesis set from
          the source genesis.json.
        </p>
      </header>
      <div className="overflow-x-auto rounded-xl bg-surface shadow-[var(--shadow-border)]">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-subtle">
            <tr>
              {["Moniker", "Address", "Stake", "Proposed", "Rewards"].map((h) => (
                <th key={h} className="px-4 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {snap.validators.map((v) => (
              <tr key={v.address} className="border-t border-border">
                <td className="px-4 py-3">{v.moniker}</td>
                <td className="px-4 py-3">
                  <Link className="font-mono text-accent" to="/address/$addr" params={{ addr: v.address }}>
                    {truncateHash(v.address)}
                  </Link>
                </td>
                <td className="px-4 py-3 font-mono">{formatAmount(v.bondedStake)}</td>
                <td className="px-4 py-3 font-mono">{v.blocksProposed}</td>
                <td className="px-4 py-3 font-mono">{formatAmount(v.accumulatedRewards)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
