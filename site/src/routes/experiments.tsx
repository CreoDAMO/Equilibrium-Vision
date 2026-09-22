import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runExperiment } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { Button } from "@/components/ui/button";
import { DEFAULT_COUPLINGS, type Couplings } from "@/protocol/types";
import { formatSci } from "@/lib/format";

export const Route = createFileRoute("/experiments")({ component: Experiments });

const LABELS: { key: keyof Couplings; label: string }[] = [
  { key: "hash", label: "Hash admissibility λ₀" },
  { key: "structural", label: "Golden-ratio structure λ₁" },
  { key: "continuity", label: "Continuity λ₂" },
  { key: "mempool", label: "Mempool pressure λ₃" },
  { key: "fees", label: "Fee coverage λ₄" },
];

function Experiments() {
  const { network, snap } = useNetwork();
  const qc = useQueryClient();
  const [lambda, setLambda] = useState<Couplings>({ ...DEFAULT_COUPLINGS });
  const [result, setResult] = useState<{
    beforeResidual: number;
    afterResidual: number;
    beforePressure: number;
    afterPressure: number;
    delta: number;
    kind: string;
  } | null>(null);

  const mutate = useMutation({
    mutationFn: async (input: { kind: "ablate" | "pressure"; couplings?: Couplings; inject?: number }) => {
      const data = await runExperiment({ data: { network, ...input } });
      if (!("beforeResidual" in data)) throw new Error("paired result is on the loop page");
      return {
        kind: data.kind,
        beforeResidual: data.beforeResidual,
        afterResidual: data.afterResidual,
        beforePressure: data.beforePressure,
        afterPressure: data.afterDrain,
        delta: data.delta,
        height: data.block.height,
      };
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["snapshot", network] });
      toast.success(`Experiment mined block #${data.height}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Experiments</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Perturb a coupling, observe the organism, compare. If λᵢ → 0 does not change
          behaviour, the coupling is not doing work. That is allowed. The organism may
          disagree with the map.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Ablation</h2>
          <p className="mt-1 text-sm text-muted">Zero a λ and mine one block with that constitution.</p>
          <ul className="mt-4 space-y-4">
            {LABELS.map(({ key, label }) => (
              <li key={key}>
                <div className="flex justify-between text-sm">
                  <span>{label}</span>
                  <span className="font-mono tabular">{lambda[key].toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={lambda[key]}
                  onChange={(e) => setLambda({ ...lambda, [key]: Number(e.target.value) })}
                  className="mt-1 w-full accent-accent"
                />
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => mutate.mutate({ kind: "ablate", couplings: lambda })} disabled={mutate.isPending}>
              Mine under this λ
            </Button>
            <Button variant="ghost" onClick={() => setLambda({ ...DEFAULT_COUPLINGS })}>
              Reset λ
            </Button>
          </div>
        </div>
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">Pressure</h2>
          <p className="mt-1 text-sm text-muted">
            Inject signed actor transactions, then mine. Tests Network → Mempool → Solver.
            Current P = {snap ? snap.mempoolPressure.toFixed(3) : "—"}.
          </p>
          <Button
            className="mt-6"
            variant="secondary"
            disabled={mutate.isPending}
            onClick={() => mutate.mutate({ kind: "pressure", inject: 12 })}
          >
            Inject 12 txs and mine
          </Button>
          {result ? (
            <dl className="mt-6 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Kind</dt>
                <dd>{result.kind}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">R before</dt>
                <dd className="font-mono">{formatSci(result.beforeResidual)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">R after</dt>
                <dd className="font-mono">{formatSci(result.afterResidual)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">ΔR</dt>
                <dd className="font-mono">{formatSci(result.delta)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted">P before → after</dt>
                <dd className="font-mono">
                  {result.beforePressure.toFixed(3)} → {result.afterPressure.toFixed(3)}
                </dd>
              </div>
              <p className="pt-2 text-xs text-subtle">
                ΔR ≈ 0 under ablation means that coupling is not doing work on this
                block. That is allowed. The organism may disagree with the map.
              </p>
            </dl>
          ) : null}
        </div>
      </div>
    </div>
  );
}
