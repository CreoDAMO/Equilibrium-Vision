import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { swapPool } from "@/lib/chain-api";
import { useNetwork } from "@/lib/network-context";
import { useWallet } from "@/lib/wallet-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAmount } from "@/lib/format";

export const Route = createFileRoute("/dex")({ component: DexPage });

function DexPage() {
  const { snap, network } = useNetwork();
  const { wallet } = useWallet();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("1000");
  const swap = useMutation({
    mutationFn: (poolId: string) =>
      swapPool({
        data: {
          network,
          poolId,
          trader: wallet?.address ?? snap?.treasury ?? "",
          tokenIn: "EQU",
          amountIn: Number(amount),
        },
      }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success(`Out ${r.amountOut}`);
        qc.invalidateQueries({ queryKey: ["snapshot", network] });
      } else toast.error(r.error);
    },
  });

  if (!snap) return <p className="text-muted">Loading…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-display text-4xl tracking-tight">DEX</h1>
        <p className="mt-2 max-w-xl text-muted">
          Constant-product pools from genesis. Application organ: reserves are
          operational state, not Ω_committed. A swap does not rewrite the state root.
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
