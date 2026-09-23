import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNetwork } from "@/lib/network-context";
import { useWallet } from "@/lib/wallet-context";
import { quoteSwap } from "@/protocol/dex";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount } from "@/lib/format";

export const Route = createFileRoute("/dex")({ component: DexPage });

function DexPage() {
  const { snap, network } = useNetwork();
  const { wallet, send } = useWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("1000");
  const swap = useMutation({
    mutationFn: async (poolId: string) => {
      const pool = snap?.pools.find((p) => p.id === poolId);
      if (!pool || !wallet) return { ok: false as const, error: "unlock a wallet" };
      const quoted = quoteSwap(pool, "EQU", Number(amount));
      if (quoted <= 0) return { ok: false as const, error: "zero output" };
      const res = await send(pool.address, Number(amount), 100);
      return { ...res, amountOut: quoted };
    },
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Queued · about ${r.amountOut} out in the next block`);
        qc.invalidateQueries({ queryKey: ["snapshot", network] });
      } else toast.error(r.error ?? "refused");
    },
  });

  if (!snap) return <p className="text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl tracking-tight">DEX</h1>
        <p className="mt-2 max-w-xl text-muted">
          A swap is a signed EQU transfer to the pool. The next block applies the
          constant-product reserves and commits them in the state root.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {snap.pools.map((p) => (
          <div key={p.id} className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <h2 className="font-display text-xl">{p.id}</h2>
            <p className="mt-2 font-mono text-sm text-muted">
              {formatAmount(p.reserveA)} {p.tokenA} / {formatAmount(p.reserveB)} {p.tokenB}
            </p>
            <p className="text-xs text-subtle">fee {p.fee * 100}% · {p.txCount} swaps</p>
            <div className="mt-4 flex gap-2">
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button
                variant="secondary"
                onClick={() => swap.mutate(p.id)}
                disabled={swap.isPending || !wallet}
              >
                Swap EQU
              </Button>
            </div>
            {!wallet ? <p className="mt-2 text-xs text-subtle">Unlock a wallet to swap.</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
