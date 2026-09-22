import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@tanstack/react-query";
import { useNetwork } from "@/lib/network-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/stat";
import { formatSci, truncateHash } from "@/lib/format";
import { forgeResidual, independentVerify } from "@/protocol/light";
import { submitExternal } from "@/lib/chain-api";

export const Route = createFileRoute("/verify")({ component: VerifyPage });

function VerifyPage() {
  const { snap, network } = useNetwork();
  const [forged, setForged] = useState<ReturnType<typeof independentVerify> | null>(null);

  const local = useMemo(() => {
    if (!snap?.recentBlocks[0]) return null;
    const tip = snap.recentBlocks[0];
    const prev = snap.recentBlocks[1] ?? null;
    return independentVerify(tip, prev, snap.params);
  }, [snap]);

  const membrane = useMutation({
    mutationFn: async () => {
      if (!snap?.recentBlocks[0]) throw new Error("no tip");
      return submitExternal({
        data: { network, hash: snap.recentBlocks[0].hash, residual: 1e-12 },
      });
    },
    onSuccess: (res) => {
      if (res.ok) toast.error("Membrane admitted a forged residual — that is a protocol failure");
      else toast.message(res.error ?? "Rejected at membrane");
    },
  });

  if (!snap) return <p className="text-muted">Loading…</p>;
  const tip = snap.recentBlocks[0];
  const server = snap.lastVerify;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Verify</h1>
        <p className="mt-2 max-w-2xl text-muted">
          VerifyStationaryEvidence is a protocol operation, not a miner courtesy. This
          page recomputes the tip in your browser — one residual evaluation, no nonce
          search — and compares it to what the kernel claimed.
        </p>
      </header>

      {tip && local ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Claimed R" value={formatSci(local.claimedResidual)} hint="inside → outside" />
          <Stat label="Local R" value={formatSci(local.localResidual)} hint="outside → inside" />
          <Stat
            label="Discovery"
            value={local.discoveryIters}
            hint="nonce iterations"
          />
          <Stat label="Verify evals" value={local.verifyEvals} hint="this body" />
        </div>
      ) : null}

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl">Agreement</h2>
            <p className="mt-1 font-mono text-sm text-muted">
              tip {tip ? truncateHash(tip.hash) : "—"} · G(I) {local?.agree ? "=" : "≠"} I(E)
            </p>
          </div>
          {local ? (
            <Badge tone={local.agree ? "ok" : "danger"}>{local.agree ? "bodies agree" : "divergence"}</Badge>
          ) : null}
        </div>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
          Generative self-model: the kernel produced this block from internal state.
          Inferential self-model: this browser reconstructed residual, merkle, header
          hash, and signatures from the published evidence. Divergence is information.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <ReportCard title="Kernel (inside → outside)" report={server} />
        <ReportCard title="This browser (outside → inside)" report={local} />
      </div>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">EQ-12 membrane</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          The original TypeScript path accepted a claimed residual without rerunning
          the solver. Here a forged R = 1e-12 is locally recomputed, then offered to
          the node. Admission would be a protocol failure.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => {
              if (!tip || !snap) return;
              const fake = forgeResidual(tip);
              const prev = snap.recentBlocks[1] ?? null;
              setForged(independentVerify(fake, prev, snap.params));
            }}
          >
            Forge residual locally
          </Button>
          <Button variant="ghost" disabled={membrane.isPending} onClick={() => membrane.mutate()}>
            Submit forged claim to node
          </Button>
        </div>
        {forged ? (
          <div className="mt-5">
            <Badge tone={forged.ok ? "danger" : "ok"}>
              {forged.ok ? "forgery admitted — fail" : "forgery rejected"}
            </Badge>
            <ul className="mt-3 space-y-2 text-sm">
              {forged.checks
                .filter((c) => !c.ok)
                .map((c) => (
                  <li key={c.name} className="text-muted">
                    <span className="text-fg">{c.name}</span> — {c.detail}
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReportCard({
  title,
  report,
}: {
  title: string;
  report: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> } | null | undefined;
}) {
  return (
    <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl">{title}</h2>
        {report ? <Badge tone={report.ok ? "ok" : "danger"}>{report.ok ? "admitted" : "rejected"}</Badge> : null}
      </div>
      <ul className="mt-5 space-y-3">
        {report?.checks.map((c) => (
          <li key={c.name} className="flex items-start justify-between gap-4 text-sm">
            <div>
              <div className="font-medium">{c.name}</div>
              <div className="text-muted">{c.detail}</div>
            </div>
            <Badge tone={c.ok ? "ok" : "danger"}>{c.ok ? "pass" : "fail"}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
