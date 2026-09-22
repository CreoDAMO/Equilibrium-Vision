import { createFileRoute } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";
import { truncateHash } from "@/lib/format";

export const Route = createFileRoute("/state")({ component: StatePage });

function StatePage() {
  const { snap } = useNetwork();
  if (!snap) return <p className="text-muted">Loading…</p>;
  const { wholes } = snap;
  const cols = [
    { title: "Committed", items: wholes.committed, note: "stateRoot binds these" },
    { title: "Observed", items: wholes.observed, note: "what this surface can see" },
    { title: "Operational", items: wholes.operational, note: "needed to compute Ωt+1" },
    { title: "Whole", items: wholes.whole, note: "the organism, including theory" },
  ];
  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl tracking-tight">State</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Four wholes. The state root is a compressed memory fingerprint, not the organism.
          Tip state root {truncateHash(snap.recentBlocks[0]?.stateRoot ?? "")}.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {cols.map((c) => (
          <div key={c.title} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <h2 className="font-display text-xl">{c.title}</h2>
            <p className="mt-1 text-xs text-subtle">{c.note}</p>
            <ul className="mt-4 space-y-2 text-sm text-muted">
              {c.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
