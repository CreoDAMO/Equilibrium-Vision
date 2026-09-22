import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listBidirectionalLog, runExperiment } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { formatSci } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/loop")({ component: LoopPage });

function LoopPage() {
  const { network, snap } = useNetwork();
  const qc = useQueryClient();
  const log = useQuery({
    queryKey: ["bidi", network],
    queryFn: () => listBidirectionalLog({ data: { network } }),
    refetchInterval: 4000,
  });
  const paired = useMutation({
    mutationFn: () => runExperiment({ data: { network, kind: "paired", key: "mempool", inject: 12 } }),
    onSuccess: (data) => {
      const causal = "causal" in data && data.causal;
      toast.success(causal ? "λ₃ changed the solve" : "λ₃ did not change this pair");
      qc.invalidateQueries({ queryKey: ["bidi", network] });
      qc.invalidateQueries({ queryKey: ["snapshot", network] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Paired run failed"),
  });
  const trial = snap?.lastBidirectional;
  const pair = snap?.lastPaired;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-[0.2em] text-subtle">Claim → prediction → test → evidence</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Bidirectional audit</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Inside produces a block. Outside recomputes it. Agreement on this path is a measurement,
          not a proof that every transition is closed. New claims wait until these rows exist.
        </p>
      </header>

      {trial ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Claimed R" value={formatSci(trial.claimedR)} hint="G(I) · kernel" />
          <Stat label="Inferred R" value={formatSci(trial.inferredR)} hint="I(E) · recompute" />
          <Stat label="Agree" value={trial.agree ? "yes" : "no"} hint={`height ${trial.height}`} />
          <Stat
            label="Cost"
            value={`${trial.discoveryIters} / ${trial.verifyEvals}`}
            hint="discovery iters / verify evals"
          />
        </div>
      ) : (
        <p className="text-sm text-muted">Waiting for a tip.</p>
      )}

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-xl">Persisted comparisons</h2>
            <p className="mt-1 text-sm text-muted">
              One row per height. {snap?.persisted ? "This kernel restored from the database." : "First boot — writing the chain now."}
            </p>
          </div>
          <Badge tone={log.data?.every((r) => r.agree) ? "ok" : "warn"}>
            {log.data?.length ?? 0} heights
          </Badge>
        </div>
        <ul className="mt-4 divide-y divide-border">
          {(log.data ?? []).map((r) => (
            <li key={r.height} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div>
                <div className="font-mono">#{r.height}</div>
                <div className="text-xs text-muted">
                  claimed {formatSci(Number(r.claimed_r), 2)} · inferred {formatSci(Number(r.inferred_r), 2)}
                </div>
              </div>
              <div className="text-right">
                <Badge tone={r.agree ? "ok" : "danger"}>{r.agree ? "agree" : "diverge"}</Badge>
                <div className="mt-1 font-mono text-xs text-muted">
                  {r.discovery_iters} → {r.verify_evals}
                </div>
              </div>
            </li>
          ))}
          {log.data && log.data.length === 0 ? (
            <li className="py-3 text-sm text-muted">No rows yet. The next block writes one.</li>
          ) : null}
        </ul>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Paired λ₃</h2>
          <p className="mt-2 text-sm text-muted">
            Same queued transactions. One arm keeps λ_mempool. The other sets it to 0. A single
            run does not prove causation. ΔR and nonce are the evidence.
          </p>
          <Button className="mt-4" disabled={paired.isPending} onClick={() => paired.mutate()}>
            Run paired ablation
          </Button>
          {pair && pair.key === "mempool" ? (
            <dl className="mt-5 space-y-2 text-sm">
              <Row k="Pressure at solve" v={pair.pressureAtSolve.toFixed(3)} />
              <Row k="R with λ₃" v={formatSci(pair.withLambda.residual)} />
              <Row k="R with λ₃ = 0" v={formatSci(pair.withoutLambda.residual)} />
              <Row k="ΔR" v={formatSci(pair.deltaR)} />
              <Row k="Δ iterations" v={String(pair.deltaIters)} />
              <Row k="Nonce changed" v={pair.withLambda.nonce === pair.withoutLambda.nonce ? "no" : "yes"} />
              <div className="pt-2">
                <Badge tone={pair.causal ? "ok" : "warn"}>{pair.causal ? "behavior changed" : "no observable change"}</Badge>
              </div>
            </dl>
          ) : (
            <p className="mt-4 text-sm text-subtle">No paired λ₃ result on this kernel yet.</p>
          )}
        </div>
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Not claimed</h2>
          <ul className="mt-3 space-y-3 text-sm text-muted">
            <li>The variational identity is not proven by these rows.</li>
            <li>ZK does not prove Ωt → Ωt+1.</li>
            <li>libp2p and the Android APK are source bodies until they speak this packet.</li>
            <li>P rising does not imply R rising. The paired arm is the test.</li>
            <li>Agreement on the tested path is not universal organismhood.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
