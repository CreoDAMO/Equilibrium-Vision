import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetArbitrageStatus,
  useGetArbitrageOpportunities,
  useSetArbitrageModel,
  usePauseArbitrage,
  useUnpauseArbitrage,
  useExecuteArbitrage,
  getGetArbitrageStatusQueryKey,
  getGetArbitrageOpportunitiesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Zap, Pause, Play, CheckCircle2, XCircle, AlertTriangle, RefreshCw, Settings2 } from "lucide-react";
import { useWallet } from "@/wallet/context";
import { formatAmount } from "@/lib/format";

function StatusMessage({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <div className={`flex items-start gap-2 text-sm p-2 rounded ${msg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
      {msg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      {msg.text}
    </div>
  );
}

// ── Admin controls ────────────────────────────────────────────────────────────

function AdminControls({ paused, onChanged }: { paused: boolean; onChanged: () => void }) {
  const { wallet } = useWallet();
  const [adminKey, setAdminKey] = useState("");
  const [registryAddress, setRegistryAddress] = useState("");
  const [modelId, setModelId] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const headers = adminKey ? { "X-Admin-Key": adminKey } : undefined;

  const setModel = useSetArbitrageModel({
    request: { headers },
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Set model failed" }); return; }
        setMsg({ ok: true, text: "Model updated." });
        onChanged();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });
  const pause = usePauseArbitrage({
    request: { headers },
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Pause failed" }); return; }
        setMsg({ ok: true, text: "Paused." });
        onChanged();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });
  const unpause = useUnpauseArbitrage({
    request: { headers },
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Unpause failed" }); return; }
        setMsg({ ok: true, text: "Unpaused." });
        onChanged();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleSetModel = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    if (!registryAddress.trim() || !modelId.trim()) { setMsg({ ok: false, text: "Registry address and model id are required." }); return; }
    setModel.mutate({
      data: { caller: wallet.address, registryAddress: registryAddress.trim().toLowerCase(), modelId: Number(modelId) },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Settings2 className="w-4 h-4" /> Owner Controls</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label>X-Admin-Key</Label>
          <Input type="password" placeholder="Required if ADMIN_KEY is set on the server" value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)} className="mt-1 text-sm" />
        </div>

        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={pause.isPending || paused || !wallet}
            onClick={() => wallet?.address && pause.mutate({ data: { caller: wallet.address } })}>
            <Pause className="w-3.5 h-3.5 mr-1.5" /> {pause.isPending ? "Pausing…" : "Pause"}
          </Button>
          <Button size="sm" variant="outline" disabled={unpause.isPending || !paused || !wallet}
            onClick={() => wallet?.address && unpause.mutate({ data: { caller: wallet.address } })}>
            <Play className="w-3.5 h-3.5 mr-1.5" /> {unpause.isPending ? "Unpausing…" : "Unpause"}
          </Button>
        </div>

        <form onSubmit={handleSetModel} className="space-y-2 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Set active ModelRegistry model</p>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Registry address (40 hex)" value={registryAddress}
              onChange={(e) => setRegistryAddress(e.target.value)} className="font-mono text-xs" />
            <Input placeholder="Model ID" type="number" value={modelId}
              onChange={(e) => setModelId(e.target.value)} className="text-sm" />
          </div>
          <Button type="submit" size="sm" disabled={setModel.isPending}>
            {setModel.isPending ? "Updating…" : "Set Model"}
          </Button>
        </form>

        <StatusMessage msg={msg} />
      </CardContent>
    </Card>
  );
}

// ── Execute form ──────────────────────────────────────────────────────────────

function ExecuteForm({ onChanged }: { onChanged: () => void }) {
  const { wallet } = useWallet();
  const [poolIds, setPoolIds] = useState("");
  const [tokenIn, setTokenIn] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [minProfit, setMinProfit] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const execute = useExecuteArbitrage({
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Execution failed" }); return; }
        setMsg({ ok: true, text: `Executed — profit ${formatAmount(data.profit ?? 0)}` });
        onChanged();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    const ids = poolIds.split(",").map((s) => s.trim()).filter(Boolean);
    const amt = Number(amountIn);
    if (ids.length === 0 || !tokenIn.trim() || !Number.isFinite(amt) || amt <= 0) {
      setMsg({ ok: false, text: "Provide pool IDs, a start token, and a positive amount." });
      return;
    }
    execute.mutate({
      data: { caller: wallet.address, poolIds: ids, tokenIn: tokenIn.trim(), amountIn: amt, minProfit: minProfit ? Number(minProfit) : 0 },
    });
  };

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Zap className="w-4 h-4" /> Execute Cycle</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Pool IDs (comma-separated, in cycle order)</Label>
            <Input placeholder="pool-1, pool-2, pool-3" value={poolIds}
              onChange={(e) => setPoolIds(e.target.value)} className="mt-1 text-sm" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1">
              <Label>Start token</Label>
              <Input placeholder="EQU" value={tokenIn} onChange={(e) => setTokenIn(e.target.value)} className="mt-1 text-sm" />
            </div>
            <div className="col-span-1">
              <Label>Amount in</Label>
              <Input type="number" min="0" value={amountIn} onChange={(e) => setAmountIn(e.target.value)} className="mt-1 text-sm" />
            </div>
            <div className="col-span-1">
              <Label>Min profit</Label>
              <Input type="number" min="0" value={minProfit} onChange={(e) => setMinProfit(e.target.value)} className="mt-1 text-sm" />
            </div>
          </div>
          <StatusMessage msg={msg} />
          <Button type="submit" className="w-full" disabled={execute.isPending || !wallet}>
            {execute.isPending ? "Executing…" : "Execute"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Permissionless — the contract's own safety rails (pause switch, model maturity, max size, circuit breaker) gate whether this does anything.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Opportunities table ───────────────────────────────────────────────────────

function OpportunitiesCard() {
  const params = { limit: 5 };
  const { data, isLoading, isError, refetch, isFetching } = useGetArbitrageOpportunities(params, {
    query: { queryKey: getGetArbitrageOpportunitiesQueryKey(params), refetchInterval: 15000 },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2"><Zap className="w-4 h-4" /> Live Opportunities</CardTitle>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <p className="p-6 text-center text-muted-foreground">Scanning pools…</p>
        ) : isError ? (
          <p className="p-6 text-center text-destructive">Arbitrage scan failed.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cycle</TableHead>
                <TableHead className="text-right">Profit factor</TableHead>
                <TableHead className="text-right">Expected profit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.opportunities.map((op, i) => (
                <TableRow key={i}>
                  <TableCell className="text-sm">{op.tokens.join(" → ")}</TableCell>
                  <TableCell className="text-right font-mono text-sm text-green-600">+{(op.profitFactor * 100).toFixed(2)}%</TableCell>
                  <TableCell className="text-right font-medium text-green-600">+{formatAmount(op.expectedProfit)} {op.tokens[0]}</TableCell>
                </TableRow>
              ))}
              {(!data || data.opportunities.length === 0) && (
                <TableRow><TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  No profitable cycles detected across {data?.poolsScanned ?? 0} pools.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ArbitragePage() {
  const { data, isLoading, error, refetch } = useGetArbitrageStatus({
    query: { queryKey: getGetArbitrageStatusQueryKey(), refetchInterval: 10000 },
  });
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getGetArbitrageStatusQueryKey() });

  if (isLoading) return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-muted rounded-xl w-14 h-14 animate-pulse" />
        <div className="space-y-2">
          <div className="h-8 w-40 bg-muted rounded animate-pulse" />
          <div className="h-4 w-64 bg-muted rounded animate-pulse" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-muted/40 rounded-lg animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />)}
      </div>
    </div>
  );

  if (error || !data) return (
    <div className="p-8 text-center">
      <p className="text-destructive font-medium">Arbitrage contract not deployed or unreachable.</p>
      <button onClick={() => refetch()} className="mt-3 text-sm text-primary hover:underline">Retry</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 text-primary p-3 rounded-xl">
            <Zap className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Arbitrage</h1>
            <p className="text-sm text-muted-foreground mt-1 font-mono">{data.address}</p>
          </div>
        </div>
        <div className="flex gap-2">
          {data.paused
            ? <Badge variant="outline" className="border-amber-200 text-amber-700 bg-amber-50"><Pause className="w-3 h-3 mr-1" /> Paused</Badge>
            : <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50"><Play className="w-3 h-3 mr-1" /> Active</Badge>}
          {data.circuitTripped && (
            <Badge variant="outline" className="border-red-200 text-red-700 bg-red-50"><AlertTriangle className="w-3 h-3 mr-1" /> Circuit Tripped</Badge>
          )}
        </div>
      </div>

      {data.circuitTripped && (
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription>The circuit breaker has tripped — executions are blocked until an owner intervenes.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Active Model</p>
          <p className="text-2xl font-bold">{data.modelId ?? "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Executions</p>
          <p className="text-2xl font-bold">{data.execCount}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Owner</p>
          <p className="text-sm font-mono truncate">{data.owner ?? "—"}</p>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Registry</p>
          <p className="text-sm font-mono truncate">{data.registry ?? "—"}</p>
        </CardContent></Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 space-y-6">
          <AdminControls paused={data.paused} onChanged={invalidate} />
          <ExecuteForm onChanged={invalidate} />
        </div>
        <div className="lg:col-span-2">
          <OpportunitiesCard />
        </div>
      </div>
    </div>
  );
}
