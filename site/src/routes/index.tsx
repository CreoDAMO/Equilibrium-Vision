import { createFileRoute, Link } from "@tanstack/react-router";
import { OrganismLoop } from "@/components/organism-loop";
import { Stat } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useNetwork } from "@/lib/network-context";
import { getSnapshot } from "@/lib/chain-api";
import { formatAmount, formatSci, timeAgo, truncateHash } from "@/lib/format";
import { HashLink } from "@/components/hash-link";

export const Route = createFileRoute("/")({
  loader: () => getSnapshot({ data: { network: "testnet" } }),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  const { snap, network } = useNetwork();
  const data = snap ?? initial;

  return (
    <div className="space-y-10">
      <section className="relative overflow-hidden rounded-xl bg-surface px-5 py-10 shadow-[var(--shadow-border)] sm:px-10 sm:py-14">
        <div className="eq-grid pointer-events-none absolute inset-0" />
        <div className="relative max-w-2xl">
          <Badge tone="muted">equilibrium.site · {network}</Badge>
          <h1 className="mt-4 font-display text-4xl leading-[1.1] tracking-tight sm:text-5xl">
            A closed system that has to keep proving it is still itself.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">
            Equilibrium is not a module list. It is an organism: perception, metabolism,
            memory, verification, and adaptation — modelled inside-out and outside-in.
            Testnet and mainnet run here, live, with a real stationary solver. No random
            residuals.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/explorer">Open the explorer</Link>
            </Button>
            <Button variant="secondary" asChild>
              <Link to="/experiments">Run an ablation</Link>
            </Button>
            <Button variant="ghost" asChild>
              <Link to="/verify">Verify the tip</Link>
            </Button>
          </div>
        </div>
      </section>

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Height" value={formatAmount(data.height)} hint={`finalized ${data.finalizedHeight} · lag ${data.height - data.finalizedHeight}`} />
            <Stat label="Canonical R" value={formatSci(data.lastResidual)} hint={`territory ${formatSci(data.lastTerritoryResidual)}`} />
            <Stat label="Mempool P" value={data.mempoolPressure.toFixed(3)} hint={`${data.mempoolSize} queued`} />
            <Stat label="Validators" value={data.validatorCount} hint={`${formatAmount(data.totalBonded)} bonded`} />
          </div>

          <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-6">
            <h2 className="font-display text-xl">What you can do with EQU today</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              Measured on a fork of this kernel. This is not a listing, and it is not a promise that a balance here exists anywhere else.
            </p>
            <ul className="mt-4 space-y-3">
              {data.use.map((row) => (
                <li key={row.id} className="flex items-start gap-3 text-sm">
                  <Badge tone={row.status === "works" ? "ok" : row.status === "absent" ? "danger" : "warn"}>
                    {row.status === "works" ? "works" : row.status === "local" ? "only here" : row.status === "disagrees" ? "disagrees" : "does not"}
                  </Badge>
                  <span className="text-muted">{row.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-6">
            <h2 className="font-display text-xl">What still has to be specified</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted">
              One state and one set of inputs should force one next state, whichever body runs the transition. successor already does that for one fully specified input. These rows are what that input has to contain, and where EQ-00 through EQ-21 are silent or say something the executable does not do.
            </p>
            <ul className="mt-4 space-y-3">
              {data.dependencies
                .filter((row) => row.verdict !== "fixed")
                .map((row) => (
                  <li key={row.id} className="text-sm text-muted">
                    <span className="font-medium">{row.id}</span>
                    {" · "}
                    {row.specifiedBy}
                    {" · "}
                    {row.detail}
                  </li>
                ))}
            </ul>
          </section>

          <OrganismLoop
            events={data.events}
            residual={data.lastResidual}
            pressure={data.mempoolPressure}
          />

          <section className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-xl">Latest blocks</h2>
                <Link to="/explorer" className="text-sm text-accent">
                  All
                </Link>
              </div>
              <ul className="mt-4 divide-y divide-border">
                {data.recentBlocks.slice(0, 6).map((b) => (
                  <li key={b.hash} className="flex items-center justify-between gap-3 py-3 text-sm">
                    <div>
                      <HashLink kind="block" value={b.hash} />
                      <div className="text-xs text-muted" suppressHydrationWarning>
                        #{b.height} · {b.txCount} tx · {timeAgo(b.timestamp)}
                      </div>
                    </div>
                    <div className="text-right font-mono text-xs text-muted">
                      <div>R {formatSci(b.residual, 2)}</div>
                      {b.verified ? <span className="text-ok">verified</span> : <span className="text-danger">unverified</span>}
                      {b.finalized ? <span className="ml-2 text-muted">final</span> : <span className="ml-2 text-warn">pending</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
              <h2 className="font-display text-xl">What this node will not claim</h2>
              <ul className="mt-4 space-y-3 text-sm leading-relaxed text-muted">
                <li>The theory does not prove the code. Ablation tests the couplings.</li>
                <li>
                  Territory residual from the Rust solver saturates. Canonical residual is the
                  rebuild quantity used for admission.
                </li>
                <li>
                  ZK does not prove the full state transition. Light bodies recompute residual;
                  they do not re-solve.
                </li>
                <li>
                  New blocks bind chain id {data.params.chainId}. Genesis {truncateHash(data.genesisHash)} is
                  this network's header, not a shared object.
                </li>
                <li>
                  {data.constitution?.q1
                    ? `The transition is successor, not this process. One next state once transactions, evidence, miner, and timestamp are fixed. At least ${data.constitution.admittingNonces} nonces in a window of ${data.constitution.nonceWindow} satisfy the residual predicate${data.constitution.admittingShareState ? " and share one Ω" : ""}. A vote changes Ω only inside the block.`
                    : "The transition relation did not close. The page is not claiming a constitution it could not run."}
                </li>
              </ul>
              <div className="mt-5 flex flex-wrap gap-3">
                <Button variant="secondary" size="sm" asChild>
                  <Link to="/audit">Claim audit</Link>
                </Button>
                <Button variant="ghost" size="sm" asChild>
                  <Link to="/protocol">EQ specifications</Link>
                </Button>
              </div>
            </div>
          </section>
        </>
      ) : (
        <p className="text-sm text-muted">Waking the {network} kernel…</p>
      )}
    </div>
  );
}
