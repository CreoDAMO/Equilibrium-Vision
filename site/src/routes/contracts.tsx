import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { stakeAction } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { useWallet } from "@/lib/wallet-context";
import { CONTRACT_ORGANS } from "@/protocol/organs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount, truncateHash } from "@/lib/format";

export const Route = createFileRoute("/contracts")({ component: ContractsPage });

function ContractsPage() {
  const { network, snap } = useNetwork();
  const { wallet } = useWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("1000");
  const [title, setTitle] = useState("Adjust λ₃");
  const [validator, setValidator] = useState("");
  const act = useMutation({
    mutationFn: (input: { op: "delegate" | "propose" | "model"; validator?: string; amount?: number; title?: string }) =>
      stakeAction({
        data: {
          network,
          op: input.op,
          address: wallet?.address ?? "",
          validator: input.validator,
          amount: input.amount,
          title: input.title,
        },
      }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success("Recorded");
        qc.invalidateQueries({ queryKey: ["snapshot", network] });
      } else toast.error(String(r.error ?? "refused"));
    },
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Contracts</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Every crate under contracts/ is listed. Live means this kernel runs the economics.
          WASM bytecode is not executed. BTC, ETH, and the Solidity ZKML verifier stay source-only
          so they cannot wear a false badge.
        </p>
      </header>

      <div className="grid gap-4">
        {CONTRACT_ORGANS.map((c) => (
          <article key={c.id} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-xl">{c.title}</h2>
              <div className="flex gap-2">
                <Badge tone="muted">{c.layer}</Badge>
                <Badge tone={c.live ? "ok" : "warn"}>{c.live ? "live" : "source only"}</Badge>
              </div>
            </div>
            <p className="mt-1 font-mono text-xs text-subtle">{c.path}</p>
            <p className="mt-3 text-sm text-muted">{c.summary}</p>
            <ul className="mt-3 space-y-1 text-sm">
              {c.methods.map((m) => (
                <li key={m.id} className="flex gap-3">
                  <span className="w-6 font-mono text-subtle">{m.id}</span>
                  <span>{m.name}</span>
                  <span className="text-muted">{m.note}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
          <h2 className="font-display text-xl">Delegate</h2>
          <p className="text-sm text-muted">Debits your balance. Raises bonded stake. Not a slash button.</p>
          <Input
            placeholder="Validator address"
            value={validator || snap?.validators[0]?.address || ""}
            onChange={(e) => setValidator(e.target.value)}
          />
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Button
            disabled={!wallet || act.isPending}
            onClick={() =>
              act.mutate({
                op: "delegate",
                validator: (validator || snap?.validators[0]?.address || "").toLowerCase(),
                amount: Number(amount),
              })
            }
          >
            Delegate
          </Button>
          {!wallet ? <p className="text-xs text-subtle">Create a wallet first. Faucet on testnet.</p> : null}
          <ul className="space-y-2 text-sm text-muted">
            {(snap?.delegations ?? []).slice(0, 5).map((d, i) => (
              <li key={`${d.delegator}-${i}`}>
                {truncateHash(d.delegator, 6)} → {truncateHash(d.validator, 6)} · {formatAmount(d.amount)}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
          <h2 className="font-display text-xl">Governance and models</h2>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button
            variant="secondary"
            disabled={!wallet || act.isPending}
            onClick={() => act.mutate({ op: "propose", title, amount: 1 })}
          >
            Submit proposal
          </Button>
          <Button variant="ghost" disabled={act.isPending} onClick={() => act.mutate({ op: "model" })}>
            Propose a model claim
          </Button>
          <ul className="space-y-2 text-sm">
            {(snap?.proposals ?? []).map((p) => (
              <li key={p.id} className="text-muted">
                #{p.id} {p.title} · {p.status}
              </li>
            ))}
            {(snap?.models ?? []).map((m) => (
              <li key={m.id} className="text-muted">
                model #{m.id} {m.status} · not zkML
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
