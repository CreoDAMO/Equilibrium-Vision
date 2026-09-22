import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { Stat } from "@/components/stat";
import { HashLink } from "@/components/hash-link";
import { formatAmount, formatSci, timeAgo } from "@/lib/format";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/explorer")({ component: Explorer });

function Explorer() {
  const { snap, network } = useNetwork();
  if (!snap) return <p className="text-muted">Loading chain…</p>;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-subtle">{snap.params.name}</p>
        <h1 className="mt-1 font-display text-4xl tracking-tight">Network</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Observable projection of the live {network} kernel. Height, residual, mempool
          pressure, and finality are independent readings of the same organism.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Height" value={formatAmount(snap.height)} />
        <Stat label="TPS" value={snap.tps.toFixed(2)} hint={`${formatAmount(snap.totalTxCount)} txs`} />
        <Stat label="Difficulty" value={formatAmount(snap.difficulty)} />
        <Stat label="Supply" value={formatAmount(snap.supply)} />
      </div>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">Pressure and residual</h2>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={snap.stats}>
              <CartesianGrid stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="height" tick={{ fill: "var(--color-muted)", fontSize: 11 }} />
              <YAxis yAxisId="l" tick={{ fill: "var(--color-muted)", fontSize: 11 }} width={40} />
              <YAxis
                yAxisId="r"
                orientation="right"
                tick={{ fill: "var(--color-muted)", fontSize: 11 }}
                width={56}
                tickFormatter={(v: number) => Number(v).toExponential(1)}
              />
              <Tooltip
                contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8 }}
                labelStyle={{ color: "var(--color-fg)" }}
              />
              <Line yAxisId="l" type="monotone" dataKey="mempoolPressure" stroke="var(--color-accent)" dot={false} name="Pressure" />
              <Line yAxisId="r" type="monotone" dataKey="residual" stroke="var(--color-ok)" dot={false} name="Residual" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Blocks" to="/blocks">
          {snap.recentBlocks.map((b) => (
            <Row
              key={b.hash}
              left={<HashLink kind="block" value={b.hash} />}
              mid={`#${b.height} · ${b.txCount} tx`}
              right={formatSci(b.residual, 2)}
              hint={timeAgo(b.timestamp)}
            />
          ))}
        </Panel>
        <Panel title="Transactions" to="/mempool">
          {snap.recentTxs.slice(0, 12).map((t) => (
            <Row
              key={t.hash}
              left={<HashLink kind="tx" value={t.hash} />}
              mid={`${formatAmount(t.amount)} EQU`}
              right={t.status}
            />
          ))}
        </Panel>
      </div>
    </div>
  );
}

function Panel({ title, to, children }: { title: string; to: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-xl">{title}</h2>
        <Link to={to} className="text-sm text-accent">
          Open
        </Link>
      </div>
      <div className="mt-3 divide-y divide-border">{children}</div>
    </div>
  );
}

function Row({
  left,
  mid,
  right,
  hint,
}: {
  left: ReactNode;
  mid: string;
  right: ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 text-sm">
      <div>
        {left}
        <div className="text-xs text-muted">
          {mid}
          {hint ? ` · ${hint}` : ""}
        </div>
      </div>
      <div className="font-mono text-xs text-muted">{right}</div>
    </div>
  );
}
