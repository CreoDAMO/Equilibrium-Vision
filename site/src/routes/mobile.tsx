import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useNetwork } from "@/lib/network-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/stat";
import { formatSci, truncateHash } from "@/lib/format";
import { independentVerify, type IndependentReport } from "@/protocol/light";
import { participation, type DeviceResources } from "@/protocol/membranes";
import type { BlockRecord } from "@/protocol/types";

export const Route = createFileRoute("/mobile")({ component: MobilePage });

const COOL: DeviceResources = { thermalC: 31, battery: 0.86 };
const HOT: DeviceResources = { thermalC: 46, battery: 0.12 };

const PIPELINE = [
  { name: "continuity", label: "Chain continuity", why: "prev_hash matches the real tip" },
  { name: "timestamp", label: "Timestamp sanity", why: "monotonic, not more than 2h in the future" },
  { name: "residual-recompute", label: "Residual re-verify", why: "one joint evaluation, no nonce search" },
  { name: "merkle", label: "Merkle recompute", why: "tx hashes → root" },
  { name: "header-hash", label: "Header commitment", why: "binds merkle, state root, nonce, residual, pressure" },
  { name: "signatures", label: "Optional BFT / sigs", why: "Ed25519 on included txs; quorum is not required to advance" },
] as const;

function MobilePage() {
  const { snap } = useNetwork();
  const [selected, setSelected] = useState<string | null>(null);
  const [hot, setHot] = useState(false);
  const resources = hot ? HOT : COOL;
  const policy = participation(resources);

  const blocks = snap?.recentBlocks ?? [];
  const hash = selected ?? blocks[0]?.hash ?? null;
  const idx = blocks.findIndex((b) => b.hash === hash);
  const block: BlockRecord | undefined = idx >= 0 ? blocks[idx] : undefined;
  const prev = idx >= 0 ? (blocks[idx + 1] ?? null) : null;

  const report: IndependentReport | null = useMemo(() => {
    if (!snap || !block) return null;
    if (policy === "defer") return null;
    return independentVerify(block, prev, snap.params);
  }, [snap, block, prev, policy]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Mobile body</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Mobile verifies this organism. It does not keep another one. Heat and battery
          decide whether this device solves, only verifies, or waits. That decision is
          not canonical state. A nonce found here is a candidate. The kernel admits it.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Light tip" value={block ? `#${block.height}` : "—"} hint={block ? truncateHash(block.hash, 6) : ""} />
        <Stat
          label="Discovery cost"
          value={block?.solverIterations ?? "—"}
          hint="kernel nonce iters"
        />
        <Stat label="Verify cost" value={policy === "defer" ? "deferred" : 1} hint="evals in this body" />
        <Stat
          label="Agreement"
          value={policy === "defer" ? "—" : report?.agree ? "yes" : "no"}
          hint={policy === "defer" ? "device is waiting" : report ? formatSci(report.localResidual) : "waiting"}
        />
      </div>

      <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-subtle">Light header packet</p>
            <h2 className="mt-1 font-display text-xl">What this body actually receives</h2>
          </div>
          <Button
            variant={policy === "defer" ? "secondary" : "ghost"}
            onClick={() => setHot((v) => !v)}
          >
            {policy === "defer" ? "Device hot — waiting" : `${policy} · ${resources.thermalC}°C`}
          </Button>
        </div>
        {block ? (
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
            <Row k="Hash" v={truncateHash(block.hash, 10)} />
            <Row k="Height" v={String(block.height)} />
            <Row k="Prev" v={truncateHash(block.prevHash, 10)} />
            <Row k="State root" v={truncateHash(block.stateRoot, 10)} />
            <Row k="Merkle" v={truncateHash(block.merkleRoot, 10)} />
            <Row k="Nonce" v={String(block.nonce)} />
            <Row k="Committed P" v={block.committedPressure.toFixed(3)} />
            <Row k="Claimed R" v={formatSci(block.residual)} />
          </dl>
        ) : (
          <p className="mt-4 text-sm text-muted">Waiting for a tip.</p>
        )}
        <div className="mt-5 flex flex-wrap gap-2">
          {blocks.slice(0, 8).map((b) => (
            <button
              key={b.hash}
              type="button"
              onClick={() => setSelected(b.hash)}
              className="min-h-11 rounded-md bg-bg-elevated px-3 font-mono text-xs shadow-[var(--shadow-border)]"
            >
              #{b.height}
            </button>
          ))}
        </div>
      </div>

      {policy === "defer" ? (
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
          <Badge tone="warn">deferred</Badge>
          <p className="mt-3 max-w-xl text-sm text-muted">
            This device is too hot or too low to verify. Deferral is not acceptance.
            The header stays unchecked. Temperature is not written into Ω. A peer
            introduced by QR or NFC is a bootstrap string in the local book, and a
            peer hello is not a block.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {PIPELINE.map((step) => {
            const check = report?.checks.find((c) => c.name === step.name);
            return (
              <div
                key={step.name}
                className="flex items-start justify-between gap-4 rounded-lg bg-surface px-4 py-3 shadow-[var(--shadow-border)]"
              >
                <div>
                  <div className="text-sm">{step.label}</div>
                  <div className="text-xs text-muted">{check?.detail ?? step.why}</div>
                </div>
                <Badge tone={!check ? "muted" : check.ok ? "ok" : "danger"}>
                  {!check ? "—" : check.ok ? "pass" : "fail"}
                </Badge>
              </div>
            );
          })}
        </div>
      )}

      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        Full nodes perform discovery. This body tests evidence. If they disagree, the
        disagreement is the result — not a vote, not a retry of the expensive solve.
      </p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
