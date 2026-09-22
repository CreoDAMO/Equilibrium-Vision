import { createFileRoute } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { LIBRARY } from "@/protocol/library";
import { minerReward, qualityMultiplier, blockReward, SLASH_DOUBLE_SIGN, SLASH_DOWNTIME } from "@/protocol/coinomics";
import { Badge } from "@/components/ui/badge";
import { formatAmount, formatSci } from "@/lib/format";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/library")({ component: LibraryPage });

function LibraryPage() {
  const { snap } = useNetwork();
  const height = snap?.height ?? 0;
  const residual = snap?.lastResidual ?? 0;
  const target = snap?.params.residualThreshold ?? 1e-3;
  const curve = { baseReward: snap?.params.baseReward ?? 50_000_000, halvingInterval: 2_100_000 };
  const reward = minerReward(height, residual, target, curve);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Library</h1>
        <p className="mt-2 max-w-2xl text-muted">
          lib/ was a source body the public site had skipped. Coinomics now prices the coinbase.
          The rest are named so they are not invisible, and marked source-only so they are not
          counterfeit.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Height reward" value={formatAmount(blockReward(height, curve))} hint="before quality" />
        <Stat label="Quality" value={qualityMultiplier(residual, target).toFixed(3)} hint={`target ${formatSci(target)}`} />
        <Stat label="Payout" value={formatAmount(Math.floor(reward))} hint="reward × quality" />
        <Stat label="Slash" value={`${SLASH_DOWNTIME * 100}% / ${SLASH_DOUBLE_SIGN * 100}%`} hint="downtime / double-sign" />
      </div>

      <div className="space-y-3">
        {LIBRARY.map((b) => (
          <article key={b.path} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-xl">{b.title}</h2>
              <Badge tone={b.live ? "ok" : "muted"}>{b.live ? "executing" : "source only"}</Badge>
            </div>
            <p className="mt-1 font-mono text-xs text-subtle">{b.path}</p>
            <p className="mt-3 text-sm text-muted">{b.note}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
