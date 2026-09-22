import { createFileRoute, Link } from "@tanstack/react-router";
import { SPECS } from "@/protocol/specs";

export const Route = createFileRoute("/protocol/$id")({ component: SpecPage });

function SpecPage() {
  const { id } = Route.useParams();
  const spec = SPECS.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (!spec) return <p className="text-muted">Unknown specification.</p>;
  const idx = SPECS.indexOf(spec);
  const prev = SPECS[idx - 1];
  const next = SPECS[idx + 1];
  return (
    <article className="space-y-6">
      <p className="font-mono text-xs text-subtle">{spec.id}</p>
      <h1 className="font-display text-4xl tracking-tight">{spec.title}</h1>
      <p className="max-w-2xl text-lg text-muted">{spec.summary}</p>
      <div className="max-w-2xl space-y-4 text-base leading-relaxed">
        {spec.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <div className="flex justify-between text-sm">
        {prev ? (
          <Link className="text-accent" to="/protocol/$id" params={{ id: prev.id }}>
            {prev.id} {prev.title}
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link className="text-accent" to="/protocol/$id" params={{ id: next.id }}>
            {next.id} {next.title}
          </Link>
        ) : null}
      </div>
    </article>
  );
}
