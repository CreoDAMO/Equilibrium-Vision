import { createFileRoute, Link } from "@tanstack/react-router";
import { MINER_RELEASE } from "@/protocol/miner-release";

export const Route = createFileRoute("/one")({ component: OnePage });

function OnePage() {
  const release = MINER_RELEASE;
  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-[0.22em] text-subtle">Build 0</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Equilibrium One</h1>
        <p className="mt-3 max-w-2xl text-muted">
          A battery-powered instrument that searches and reports. It does not adopt a block,
          and docking it does not make it a validator.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-3">
        <article className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">What it loads</h2>
          <p className="mt-3 text-sm text-muted">
            Android {release.version}, code {release.versionCode}. The only file is the one
            this site publishes. The app asks <span className="font-mono text-fg">/api/miner/release</span> and
            does not ask a store.
          </p>
          <Link to="/miner" className="mt-4 inline-block text-sm text-accent">
            Miner download
          </Link>
        </article>
        <article className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">What a mode is</h2>
          <p className="mt-3 text-sm text-muted">
            Below 38°C and above 40% battery, it may search. Hot or low, it stops searching.
            Those are work limits. They are not authority.
          </p>
        </article>
        <article className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">What it does not hold</h2>
          <p className="mt-3 text-sm text-muted">
            A restart keeps the network and the miner address. It does not keep Ω.
            A height on the screen is the site's answer, not a local chain.
          </p>
        </article>
      </section>

      <section className="max-w-2xl space-y-4 text-sm leading-relaxed text-muted">
        <p>
          The reference assembly is an Android handheld, 8 GB of memory, 128 GB of storage,
          and USB-C. A dock may add Ethernet and power. It is not required, and it changes
          nothing about what a submission means.
        </p>
        <p>
          Carbon-nanotube logic, MRAM, and photonic search are a later investigation.
          None of them is in this enclosure, and none of them is allowed to replace the
          transition. C-007 is open. The complete specification is{" "}
          <a
            className="text-accent"
            href="https://github.com/CreoDAMO/Equilibrium-Vision/blob/main/docs/equilibrium-one.md"
          >
            docs/equilibrium-one.md
          </a>
          .
        </p>
      </section>
    </div>
  );
}
