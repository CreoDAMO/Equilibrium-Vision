import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getBlock } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { formatAmount, formatSci, formatTime, truncateHash } from "@/lib/format";
import { HashLink } from "@/components/hash-link";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/blocks/$hash")({ component: BlockDetail });

function BlockDetail() {
  const { hash } = Route.useParams();
  const { network } = useNetwork();
  const { data: block } = useQuery({
    queryKey: ["block", network, hash],
    queryFn: () => getBlock({ data: { network, id: hash } }),
  });

  if (!block) return <p className="text-muted">Block not found or still loading.</p>;

  const v = block.breakdown.violations;

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-subtle">Block {block.height}</p>
        <h1 className="break-all font-mono text-lg sm:text-xl">{block.hash}</h1>
        <div className="flex flex-wrap gap-2">
          <Badge tone={block.verified ? "ok" : "danger"}>{block.verified ? "verified" : "failed verification"}</Badge>
          <Badge tone={block.finalized ? "ok" : "warn"}>{block.finalized ? "finalized" : "pending finality"}</Badge>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Canonical R" value={formatSci(block.residual)} />
        <Stat label="Territory R" value={formatSci(block.territoryResidual)} hint="Rust-faithful, saturates" />
        <Stat label="Nonce" value={block.nonce} hint={`${block.solverIterations} iterations`} />
        <Stat label="Committed P" value={block.committedPressure.toFixed(3)} hint="bound in header" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Header</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <KV k="Previous" v={<HashLink kind="block" value={block.prevHash} />} />
            <KV k="Merkle" v={<span className="font-mono">{truncateHash(block.merkleRoot)}</span>} />
            <KV k="State root" v={<span className="font-mono">{truncateHash(block.stateRoot)}</span>} />
            <KV k="Miner" v={<Link to="/address/$addr" params={{ addr: block.miner }} className="font-mono text-accent">{truncateHash(block.miner)}</Link>} />
            <KV k="Timestamp" v={formatTime(block.timestamp)} />
            <KV k="Difficulty" v={formatAmount(block.difficulty)} />
            <KV k="Coinbase" v={formatAmount(block.coinbaseReward)} />
            <KV
              k="Evidence"
              v={
                block.evidence
                  ? `chain ${block.evidence.chainId} · btc ${block.evidence.btc.length} · eth ${block.evidence.eth.length} · wasm ${block.evidence.wasm.length} · stake ${block.evidence.stake.length}`
                  : "none · this block is from before the replay boundary"
              }
            />
          </dl>
        </div>
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Coupling violations</h2>
          <ul className="mt-4 space-y-3">
            {Object.entries(v).map(([k, val]) => (
              <li key={k}>
                <div className="flex justify-between text-xs uppercase tracking-wider text-subtle">
                  <span>{k}</span>
                  <span className="font-mono">{formatSci(val as number, 2)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.min(100, (val as number) * 200)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">Transactions</h2>
        <ul className="mt-3 divide-y divide-border">
          {block.transactions.length === 0 ? (
            <li className="py-3 text-sm text-muted">Empty block — coinbase only.</li>
          ) : (
            block.transactions.map((t) => (
              <li key={t.hash} className="flex items-center justify-between py-3 text-sm">
                <HashLink kind="tx" value={t.hash} />
                <span className="font-mono text-muted">{formatAmount(t.amount)}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}
