import { createFileRoute } from "@tanstack/react-router";
import { CLAIMS, liveEvidence, type ClaimStatus } from "@/protocol/claims";
import { Badge } from "@/components/ui/badge";
import { useNetwork } from "@/lib/network-context";

export const Route = createFileRoute("/audit")({ component: AuditPage });

const TONE: Record<ClaimStatus, "ok" | "warn" | "danger" | "muted" | "default"> = {
  survived: "ok",
  partial: "warn",
  open: "muted",
  falsified: "danger",
  territory: "default",
};

function AuditPage() {
  const { snap } = useNetwork();
  const evidence = snap ? liveEvidence(snap) : null;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Claim audit</h1>
        <p className="mt-2 max-w-2xl text-muted">
          The recap asked for this before another specification. Each claim is tested
          against the source repository and this live kernel. Live fields are
          measurements, not restated slogans.
        </p>
      </header>
      <div className="space-y-4">
        {CLAIMS.map((c) => (
          <article key={c.id} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-xl">
                {c.id} · {c.title}
              </h2>
              <Badge tone={TONE[c.status]}>{c.status}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted">{c.original}</p>
            {evidence?.[c.id] ? (
              <p className="mt-3 rounded-md bg-bg-elevated px-3 py-2 font-mono text-xs text-accent">
                live · {evidence[c.id]}
              </p>
            ) : null}
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wider text-subtle">Prediction</dt>
                <dd className="mt-1">{c.prediction}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-subtle">Inside → outside</dt>
                <dd className="mt-1">{c.insideOut}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-subtle">Outside → inside</dt>
                <dd className="mt-1">{c.outsideIn}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wider text-subtle">Closure</dt>
                <dd className="mt-1">{c.closure}</dd>
              </div>
            </dl>
            <p className="mt-4 text-sm text-subtle">{c.counter}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
