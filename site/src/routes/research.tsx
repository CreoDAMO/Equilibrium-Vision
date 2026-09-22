import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/research")({ component: Research });

function Research() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Research</h1>
        <p className="mt-2 max-w-2xl text-lg text-muted">
          The Fragmentation Was Always the Workaround. δS_closed[Φ, Θ] = 0 is a
          hypothesis about coupled behaviour, not a certificate of this binary.
        </p>
      </header>
      <section className="max-w-2xl space-y-4 leading-relaxed text-muted">
        <p>
          If a coupling is doing real work, removing it should change observable
          behaviour. The Experiments body is the instrument. The Claim audit is the
          lab notebook.
        </p>
        <p>
          Open questions we will not close in prose: Does the distributed system
          exhibit measurable behaviour consistent with a coupled closed-system
          variational structure? How much of Ω must be remembered for another body
          to identify the same organism? What evidence must exist for a mobile
          verifier to accept Ωt+1?
        </p>
        <p>
          ZK machinery in the source repository binds residual, threshold, and block
          hash. It does not yet prove the canonical state transition. Inference
          attestation is an Ed25519 receipt, not a zkML proof. Those sentences are
          copied from LIMITATIONS.md on purpose.
        </p>
      </section>
      <div className="flex flex-wrap gap-3">
        <Link to="/experiments" className="text-accent">
          Run an experiment
        </Link>
        <Link to="/audit" className="text-accent">
          Read the audit
        </Link>
        <a href="https://github.com/CreoDAMO/Equilibrium-Vision" className="text-accent">
          Source territory
        </a>
      </div>
    </div>
  );
}
