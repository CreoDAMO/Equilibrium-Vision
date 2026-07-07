import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDexPools,
  useListDexSwaps,
  useGetDexPositions,
  useGetDexQuote,
  useDexSwap,
  useAddLiquidity,
  getListDexPoolsQueryKey,
  getListDexSwapsQueryKey,
  getGetDexPositionsQueryKey,
  getGetDexQuoteQueryKey,
  type DexPoolList,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useWallet } from "@/wallet/context";
import { formatAmount, truncateHash, timeAgo } from "@/lib/format";
import { ArrowRightLeft, Droplets, TrendingUp, AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function PoolBadge({ poolId }: { poolId: string }) {
  return (
    <Badge variant="outline" className="font-mono text-xs">
      {poolId}
    </Badge>
  );
}

// ── Swap tab ──────────────────────────────────────────────────────────────────

function SwapTab({ pools }: { pools: DexPoolList | undefined }) {
  const { wallet } = useWallet();
  const qc = useQueryClient();
  const [poolId, setPoolId] = useState("");
  const [tokenIn, setTokenIn] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const selectedPool = pools?.pools.find((p) => p.id === poolId);
  const tokenOut = selectedPool ? (tokenIn === selectedPool.tokenA ? selectedPool.tokenB : selectedPool.tokenA) : "";

  // Debounced live quote
  const quoteEnabled = !!poolId && !!tokenIn && !!amountIn && Number(amountIn) > 0;
  const quoteParams = { poolId, tokenIn, amountIn };
  const { data: quote, isFetching: quoting } = useGetDexQuote(quoteParams, {
    query: {
      queryKey: getGetDexQuoteQueryKey(quoteParams),
      enabled: quoteEnabled,
      refetchInterval: false,
    },
  });

  const swapMutation = useDexSwap({
    mutation: {
      onSuccess: (data) => {
        setMsg({ ok: true, text: `Swapped ${formatAmount(data.amountIn)} ${data.tokenIn} → ${formatAmount(data.amountOut)} ${tokenOut} (fee: ${formatAmount(data.fee)})` });
        setAmountIn("");
        qc.invalidateQueries({ queryKey: getListDexPoolsQueryKey() });
        qc.invalidateQueries({ queryKey: getListDexSwapsQueryKey() });
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleSwap = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    const amt = Number(amountIn);
    if (!poolId || !tokenIn || !Number.isFinite(amt) || amt <= 0) { setMsg({ ok: false, text: "Select a pool and token, and enter a positive amount." }); return; }
    swapMutation.mutate({ data: { poolId, trader: wallet.address, tokenIn, amountIn: amt } });
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><ArrowRightLeft className="w-4 h-4" /> Swap</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSwap} className="space-y-4">
          <div>
            <Label>Pool</Label>
            <select className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-background"
              value={poolId} onChange={(e) => { setPoolId(e.target.value); setTokenIn(""); }}>
              <option value="">Select a pool…</option>
              {pools?.pools.map((p) => (
                <option key={p.id} value={p.id}>{p.id} — {p.tokenA}/{p.tokenB} (TVL: {formatAmount(p.tvl)})</option>
              ))}
            </select>
          </div>

          {selectedPool && (
            <div>
              <Label>Sell token</Label>
              <div className="flex gap-2 mt-1">
                {[selectedPool.tokenA, selectedPool.tokenB].map((t) => (
                  <button key={t} type="button"
                    className={`px-3 py-1.5 rounded-md border text-sm font-medium transition-colors ${tokenIn === t ? "bg-primary text-primary-foreground border-primary" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                    onClick={() => setTokenIn(t)}>{t}</button>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label htmlFor="amountIn">Amount in {tokenIn && `(${tokenIn})`}</Label>
            <Input id="amountIn" type="number" min="1" placeholder="0" value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)} />
          </div>

          {/* Live quote */}
          {quoteEnabled && (
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              {quoting ? (
                <div className="flex items-center gap-2 text-muted-foreground"><RefreshCw className="w-3 h-3 animate-spin" /> Calculating…</div>
              ) : quote ? (
                <>
                  <div className="flex justify-between"><span className="text-muted-foreground">You receive</span><span className="font-semibold">{formatAmount(quote.amountOut)} {tokenOut}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Fee</span><span>{formatAmount(quote.fee)} {tokenIn}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Price impact</span>
                    <span className={Number(quote.priceImpact) > 2 ? "text-orange-600 font-medium" : ""}>{quote.priceImpact}%</span>
                  </div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Rate</span><span>1 {tokenIn} = {quote.rate.toFixed(6)} {tokenOut}</span></div>
                </>
              ) : null}
            </div>
          )}

          {msg && (
            <div className={`flex items-start gap-2 text-sm p-2 rounded ${msg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
              {msg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              {msg.text}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={swapMutation.isPending || !wallet}>
            {swapMutation.isPending ? "Swapping…" : "Swap"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Add Liquidity tab ─────────────────────────────────────────────────────────

function LiquidityTab({ pools }: { pools: DexPoolList | undefined }) {
  const { wallet } = useWallet();
  const qc = useQueryClient();
  const [poolId, setPoolId] = useState("");
  const [amountA, setAmountA] = useState("");
  const [amountB, setAmountB] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const selectedPool = pools?.pools.find((p) => p.id === poolId);

  const addMutation = useAddLiquidity({
    mutation: {
      onSuccess: (data) => {
        setMsg({ ok: true, text: `Added liquidity — received ${formatAmount(data.liquidity)} LP tokens` });
        setAmountA(""); setAmountB("");
        qc.invalidateQueries({ queryKey: getListDexPoolsQueryKey() });
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    const a = Number(amountA), b = Number(amountB);
    if (!poolId || !Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) { setMsg({ ok: false, text: "Select a pool and enter positive amounts for both tokens." }); return; }
    addMutation.mutate({ data: { poolId, provider: wallet.address, amountA: a, amountB: b } });
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Droplets className="w-4 h-4" /> Add Liquidity</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleAdd} className="space-y-4">
          <div>
            <Label>Pool</Label>
            <select className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-background"
              value={poolId} onChange={(e) => setPoolId(e.target.value)}>
              <option value="">Select a pool…</option>
              {pools?.pools.map((p) => (
                <option key={p.id} value={p.id}>{p.id} — {p.tokenA}/{p.tokenB}</option>
              ))}
            </select>
          </div>

          {selectedPool && (
            <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between"><span>Current price</span><span className="font-medium text-foreground">1 {selectedPool.tokenA} = {selectedPool.price.toFixed(6)} {selectedPool.tokenB}</span></div>
              <div className="flex justify-between"><span>Reserve {selectedPool.tokenA}</span><span>{formatAmount(selectedPool.reserveA)}</span></div>
              <div className="flex justify-between"><span>Reserve {selectedPool.tokenB}</span><span>{formatAmount(selectedPool.reserveB)}</span></div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="amtA">{selectedPool?.tokenA ?? "Token A"} amount</Label>
              <Input id="amtA" type="number" min="0" placeholder="0" value={amountA}
                onChange={(e) => setAmountA(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="amtB">{selectedPool?.tokenB ?? "Token B"} amount</Label>
              <Input id="amtB" type="number" min="0" placeholder="0" value={amountB}
                onChange={(e) => setAmountB(e.target.value)} />
            </div>
          </div>

          {msg && (
            <div className={`flex items-start gap-2 text-sm p-2 rounded ${msg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
              {msg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              {msg.text}
            </div>
          )}

          <Button type="submit" className="w-full" disabled={addMutation.isPending || !wallet}>
            {addMutation.isPending ? "Adding…" : "Add Liquidity"}
          </Button>
        </form>

        {/* My LP positions */}
        {wallet?.address && <MyPositions address={wallet.address} />}
      </CardContent>
    </Card>
  );
}

function MyPositions({ address }: { address: string }) {
  const { data } = useGetDexPositions(address, {
    query: { queryKey: getGetDexPositionsQueryKey(address), refetchInterval: 10000 },
  });
  if (!data || data.positions.length === 0) return null;
  return (
    <div className="mt-4 border-t pt-4 space-y-2">
      <p className="text-sm font-medium">My LP positions</p>
      {data.positions.map((p, i) => (
        <div key={i} className="flex justify-between text-sm">
          <PoolBadge poolId={p.poolId} />
          <span className="text-muted-foreground">{formatAmount(p.liquidity)} LP ({p.sharePercent.toFixed(2)}%)</span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DexPage() {
  const { wallet } = useWallet();
  const { data: pools, isLoading } = useListDexPools({
    query: { queryKey: getListDexPoolsQueryKey(), refetchInterval: 15000 },
  });
  const swapsParams = { limit: 20 };
  const { data: swaps } = useListDexSwaps(swapsParams, {
    query: { queryKey: getListDexSwapsQueryKey(swapsParams), refetchInterval: 10000 },
  });

  const totalTvl = pools?.pools.reduce((s, p) => s + p.tvl, 0) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <ArrowRightLeft className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">DEX</h1>
          <p className="text-sm text-muted-foreground mt-1">Native AMM — constant-product x·y=k with 0.3% fee</p>
        </div>
      </div>

      {!wallet && (
        <Alert>
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription>
            <a href="/wallet" className="underline text-primary">Connect a wallet</a> to swap or provide liquidity.
          </AlertDescription>
        </Alert>
      )}

      {/* Pool overview */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Pools</p>
          <p className="text-2xl font-bold">{pools?.count ?? "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total TVL</p>
          <p className="text-2xl font-bold">{formatAmount(totalTvl)} EQU</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Recent Swaps</p>
          <p className="text-2xl font-bold">{swaps?.count ?? "—"}</p>
        </CardContent></Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Trade panel */}
        <div className="lg:col-span-1">
          <Tabs defaultValue="swap">
            <TabsList className="w-full mb-4">
              <TabsTrigger value="swap" className="flex-1">Swap</TabsTrigger>
              <TabsTrigger value="liquidity" className="flex-1">Liquidity</TabsTrigger>
            </TabsList>
            <TabsContent value="swap"><SwapTab pools={pools} /></TabsContent>
            <TabsContent value="liquidity"><LiquidityTab pools={pools} /></TabsContent>
          </Tabs>
        </div>

        {/* Pools + recent swaps */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="w-4 h-4" /> Pools</CardTitle></CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <p className="p-6 text-center text-muted-foreground">Loading pools…</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pool</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">TVL</TableHead>
                      <TableHead className="text-right">Fee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pools?.pools.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <div className="font-medium">{p.tokenA}/{p.tokenB}</div>
                          <PoolBadge poolId={p.id} />
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{p.price.toFixed(6)}</TableCell>
                        <TableCell className="text-right">{formatAmount(p.tvl)}</TableCell>
                        <TableCell className="text-right text-muted-foreground">{(p.fee * 100).toFixed(2)}%</TableCell>
                      </TableRow>
                    ))}
                    {(!pools || pools.pools.length === 0) && (
                      <TableRow><TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No pools found.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><ArrowRightLeft className="w-4 h-4" /> Recent Swaps</CardTitle></CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Trader</TableHead>
                    <TableHead>Pair</TableHead>
                    <TableHead className="text-right">In</TableHead>
                    <TableHead className="text-right">Out</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {swaps?.swaps.slice(0, 10).map((s, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs text-primary">
                        <a href={`/address/${s.trader}`}>{truncateHash(s.trader)}</a>
                      </TableCell>
                      <TableCell className="text-sm">{s.tokenIn} → {s.tokenOut}</TableCell>
                      <TableCell className="text-right text-sm">{formatAmount(s.amountIn)}</TableCell>
                      <TableCell className="text-right text-sm">{formatAmount(s.amountOut)}</TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">{timeAgo(s.timestamp)}</TableCell>
                    </TableRow>
                  ))}
                  {(!swaps || swaps.swaps.length === 0) && (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No swaps yet.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
