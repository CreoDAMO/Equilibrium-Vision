import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listBidirectionalLog, runExperiment } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { formatSci } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/stat";
import type { WholeReport } from "@/protocol/types";

export const Route = createFileRoute("/loop")({ component: LoopPage });

function isWhole(data: unknown): data is WholeReport {
  return Boolean(data && typeof data === "object" && "couplings" in data && "persistence" in data);
}

function LoopPage() {
  const { network, snap } = useNetwork();
  const qc = useQueryClient();
  const log = useQuery({
    queryKey: ["bidi", network],
    queryFn: () => listBidirectionalLog({ data: { network } }),
    refetchInterval: 4000,
  });
  const whole = useQuery({
    queryKey: ["whole", network],
    queryFn: () => runExperiment({ data: { network, kind: "whole" } }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const report = isWhole(whole.data) ? whole.data : snap?.lastWhole ?? null;
  const paired = useMutation({
    mutationFn: () => runExperiment({ data: { network, kind: "paired", key: "mempool", inject: 12 } }),
    onSuccess: (data) => {
      const discovery = data && typeof data === "object" && "discoveryEffect" in data && data.discoveryEffect;
      const formula = data && typeof data === "object" && "formulaEffect" in data && data.formulaEffect;
      toast.success(
        discovery ? "λ₃ moved the nonce" : formula ? "λ₃ moved R only — nonce unchanged" : "λ₃ did not move this pair",
      );
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
        <p className="text-xs uppercase tracking-[0.2em] text-subtle">One transition, not five pages</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Closed loop</h1>
        <p className="mt-3 max-w-2xl text-muted">
          Solver, mempool, governance, stake, finality, verify, and restore run as one measurement.
          A coupling that only changes R is not a coupling that changes discovery.
        </p>
      </header>

      {whole.isPending ? (
        <p className="text-sm text-muted">Measuring the closed transition on a fork of this kernel.</p>
      ) : null}
      {whole.isError ? (
        <p className="text-sm text-danger">
          {whole.error instanceof Error ? whole.error.message : "The whole measurement failed."}
        </p>
      ) : null}

      {report ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Verify" value={report.verifyAgrees ? "agree" : "diverge"} hint="one recompute" />
            <Stat label="Restore" value={report.persistence.restartEqual ? "equal" : "diverged"} hint="serialize then load" />
            <Stat
              label="Stake paid"
              value={report.stake.distributed.toLocaleString()}
              hint={report.stake.minerBonded ? "producer is bonded" : "producer not bonded"}
            />
            <Stat
              label="Finality"
              value={report.finality.separatedFromStationarity ? "separate" : "not shown"}
              hint={report.finality.healthyFinalized ? "healthy finalized · jailed did not" : "healthy did not finalize"}
            />
          </div>

          <section className="overflow-x-auto rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <h2 className="font-display text-xl">Same transactions, one λ removed</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted">{report.sourceLaw}</p>
            <table className="mt-4 w-full min-w-[36rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-wider text-subtle">
                <tr>
                  <th className="py-2 pr-3 font-medium">Coupling</th>
                  <th className="py-2 pr-3 font-medium">Formula ΔR</th>
                  <th className="py-2 pr-3 font-medium">Discovery</th>
                  <th className="py-2 font-medium">Reward</th>
                </tr>
              </thead>
              <tbody>
                {report.couplings.map((row) => (
                  <tr key={row.key} className="border-t border-border">
                    <td className="py-3 pr-3 font-mono">λ_{row.key}</td>
                    <td className="py-3 pr-3">{row.formulaEffect ? formatSci(row.deltaR) : "none"}</td>
                    <td className="py-3 pr-3">{row.discoveryEffect ? "nonce moved" : "nonce same"}</td>
                    <td className="py-3">{row.rewardEffect ? "changed" : "same"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
              <h2 className="font-display text-xl">Where the parts actually join</h2>
              <dl className="mt-4 space-y-2 text-sm">
                <Row
                  k="Mempool set"
                  v={
                    report.mempool.discoveryEffect
                      ? `${report.mempool.txs} txs moved the nonce`
                      : `${report.mempool.txs} txs · nonce unchanged`
                  }
                />
                <Row
                  k="Governance"
                  v={
                    report.governance.applied
                      ? `executed λ_${report.governance.key} before solve · discovery ${report.governance.discoveryEffect ? "yes" : "no"}`
                      : "message did not execute"
                  }
                />
                <Row
                  k="Coinbase"
                  v={`${report.stake.liquidIssuance} liquid · ${report.stake.distributed} to stake · reward ${report.stake.reward}`}
                />
                <Row
                  k="Finality"
                  v={`healthy ${report.finality.healthyFinalized ? "final" : "open"} · all-jailed ${report.finality.jailedFinalized ? "final" : "open"}`}
                />
                <Row
                  k="Restart"
                  v={
                    report.persistence.restartEqual
                      ? `height ${report.persistence.height} hash matches`
                      : "restored body diverged"
                  }
                />
              </dl>
            </div>
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
              <h2 className="font-display text-xl">Still not the whole source tree</h2>
              <ul className="mt-3 space-y-3 text-sm text-muted">
                <li>This kernel does not execute the Rust crate or the contract WASM.</li>
                <li>zkML, BTC SPV, and ETH sync stay source-only. Wiring them would be a false badge.</li>
                <li>In-process restore is not a Render process restart. The boot path is fixed; the restart still has to happen there.</li>
                <li>Agreement on this fork is not a proof of the variational identity.</li>
              </ul>
            </div>
          </section>
        </>
      ) : null}

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

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">Paired λ₃, alone</h2>
        <p className="mt-2 text-sm text-muted">
          Same queued transactions. One arm keeps λ_mempool. The other sets it to 0. Formula and
          discovery are reported separately, because a constant term can change R without changing the nonce.
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
            <Row k="Formula effect" v={pair.formulaEffect ? "yes" : "no"} />
            <Row k="Discovery effect" v={pair.discoveryEffect ? "nonce moved" : "nonce same"} />
          </dl>
        ) : (
          <p className="mt-4 text-sm text-subtle">No paired λ₃ result on this kernel yet.</p>
        )}
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="text-right font-mono">{v}</dd>
    </div>
  );
}
