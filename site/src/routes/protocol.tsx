import { createFileRoute, Link } from "@tanstack/react-router";
import { SPECS } from "@/protocol/specs";

export const Route = createFileRoute("/protocol")({ component: ProtocolIndex });

function ProtocolIndex() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Protocol</h1>
        <p className="mt-2 max-w-2xl text-muted">
          EQ-00 through EQ-21. Multiple bodies may implement. They do not independently
          redefine. This site is one runtime body of the same constitution.
        </p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {SPECS.map((s) => (
          <Link
            key={s.id}
            to="/protocol/$id"
            params={{ id: s.id }}
            className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] transition-transform duration-150 hover:translate-y-[-1px]"
          >
            <div className="font-mono text-xs text-subtle">{s.id}</div>
            <h2 className="mt-1 font-display text-xl">{s.title}</h2>
            <p className="mt-2 text-sm text-muted">{s.summary}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
