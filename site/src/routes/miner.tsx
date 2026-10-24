import { createFileRoute } from "@tanstack/react-router";
import { MINER_RELEASE } from "@/protocol/miner-release";
import { Stat } from "@/components/stat";

export const Route = createFileRoute("/miner")({ component: MinerPage });

function MinerPage() {
  const release = MINER_RELEASE;
  const offered = release.published && release.apkUrl.length > 0;
  const size = release.sizeBytes > 0 ? formatBytes(release.sizeBytes) : "—";

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-[0.22em] text-subtle">Android</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Miner</h1>
        <p className="mt-3 max-w-xl text-muted">
          The solver is not on a store. This page is the download, and the installed app asks
          this site when a newer build exists. Nothing else is allowed to offer one.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Version" value={release.version} hint={`code ${release.versionCode}`} />
        <Stat label="Offered" value={offered ? "yes" : "not yet"} hint={offered ? "signed file" : "manifest is closed"} />
        <Stat label="Size" value={size} />
        <Stat label="SHA-256" value={release.sha256 ? "set" : "—"} hint="compare before you install" />
      </div>

      <section className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <h2 className="font-display text-xl">This build</h2>
        <p className="mt-3 max-w-2xl text-sm text-muted">{release.notes}</p>
        {release.sha256 ? (
          <p className="mt-4 break-all font-mono text-xs text-fg">{release.sha256}</p>
        ) : null}
        {offered ? (
          <a
            className="mt-6 inline-flex min-h-11 items-center rounded-full bg-fg px-5 text-sm text-bg"
            href={release.apkUrl}
          >
            Download APK
          </a>
        ) : (
          <p className="mt-6 text-sm text-fg">
            No file is offered. A phone that checks in will be told to stay on the build it has.
          </p>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">What the app selects</h2>
          <p className="mt-3 text-sm text-muted">
            Mainnet is chain id 1. Testnet is chain id 2. The choice changes the work request
            and the submission, and mining stops before the switch. Peer gossip is held until
            a topic is bound to one chain.
          </p>
        </div>
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <h2 className="font-display text-xl">What a submission is</h2>
          <p className="mt-3 text-sm text-muted">
            The site gives the phone a light template. It does not install the phone's block.
            A submission is answered, and refused, in the open.
          </p>
        </div>
      </section>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
