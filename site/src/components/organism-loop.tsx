import { cn } from "@/lib/utils";
import type { OrganismEvent } from "@/protocol/types";

const INSIDE = [
  { id: "solver", label: "Metabolism", sub: "Stationary solve" },
  { id: "transition", label: "Transition", sub: "Ωt → Ωt+1" },
  { id: "memory", label: "Memory", sub: "Blocks / state root" },
] as const;

const OUTSIDE = [
  { id: "network", label: "Perception", sub: "Network / mempool" },
  { id: "verify", label: "Immune", sub: "Independent evidence" },
  { id: "finality", label: "Stabilise", sub: "BFT, lag 2" },
] as const;

export function OrganismLoop({
  events,
  residual,
  pressure,
}: {
  events: OrganismEvent[];
  residual: number;
  pressure: number;
}) {
  const latest = events[0];
  const counts = {
    in: events.filter((e) => e.dir === "in").length,
    out: events.filter((e) => e.dir === "out").length,
    close: events.filter((e) => e.dir === "close").length,
  };

  const isOn = (id: string) => {
    const organ = latest?.organ;
    if (!organ) return false;
    if (organ === id) return true;
    if (organ === "mempool" && id === "network") return true;
    if (organ === "wallet" && id === "network") return true;
    if (organ === "governance" && id === "finality") return true;
    return false;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="relative overflow-hidden rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] sm:p-6">
        <div className="eq-grid pointer-events-none absolute inset-0 opacity-40" />
        <div className="relative">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-subtle">Living loop</p>
              <h2 className="mt-1 font-display text-2xl tracking-tight">Inside ↔ outside</h2>
            </div>
            <div className="text-right font-mono text-xs text-muted">
              <div>R {residual.toExponential(3)}</div>
              <div>P {pressure.toFixed(3)}</div>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Inside → outside</p>
              {INSIDE.map((o) => (
                <OrganCard key={o.id} label={o.label} sub={o.sub} on={isOn(o.id)} dir={isOn(o.id) ? latest?.dir : null} />
              ))}
            </div>
            <div className="hidden flex-col items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-subtle sm:flex">
              <span>G(I)</span>
              <span className="h-12 w-px bg-border" />
              <span>I(E)</span>
            </div>
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-subtle">Outside → inside</p>
              {OUTSIDE.map((o) => (
                <OrganCard key={o.id} label={o.label} sub={o.sub} on={isOn(o.id)} dir={isOn(o.id) ? latest?.dir : null} />
              ))}
            </div>
          </div>

          <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted">
            Closure {counts.close} · inbound {counts.in} · outbound {counts.out}. Internal
            state generates a candidate; the environment returns evidence; memory
            updates only if the candidate still belongs to this constitution.
          </p>
        </div>
      </div>
      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <p className="text-xs uppercase tracking-[0.2em] text-subtle">Live events</p>
        <ul className="mt-3 space-y-2">
          {events.slice(0, 8).map((e) => (
            <li key={e.id} className="flex gap-3 text-sm" suppressHydrationWarning>
              <span
                className={cn(
                  "mt-0.5 w-10 shrink-0 font-mono text-[10px] uppercase",
                  e.dir === "in" && "text-ok",
                  e.dir === "out" && "text-accent",
                  e.dir === "close" && "text-warn",
                )}
              >
                {e.dir}
              </span>
              <span className="text-muted">{e.message}</span>
            </li>
          ))}
          {events.length === 0 ? <li className="text-sm text-muted">Waiting for first pulse.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function OrganCard({
  label,
  sub,
  on,
  dir,
}: {
  label: string;
  sub: string;
  on: boolean;
  dir: OrganismEvent["dir"] | null | undefined;
}) {
  return (
    <div
      className={cn(
        "rounded-md bg-bg-elevated p-3 shadow-[var(--shadow-border)] transition-[opacity] duration-200",
        on ? "opacity-100" : "opacity-55",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-subtle">{label}</span>
        {dir ? (
          <span className="font-mono text-[10px] text-accent">
            {dir === "in" ? "in →" : dir === "out" ? "→ out" : "↔"}
          </span>
        ) : null}
      </div>
      <div className="mt-1 text-sm text-fg">{sub}</div>
    </div>
  );
}
