import React, { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useListValidators,
  useGetStakingSummary,
  useGetStakePositions,
  useStake,
  useUnstake,
  getGetStakePositionsQueryKey,
  getGetStakingSummaryQueryKey,
  getListValidatorsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useWallet } from "@/wallet/context";
import { formatAmount, truncateHash } from "@/lib/format";
import { Coins, TrendingUp, Clock, AlertTriangle, CheckCircle2, Shield } from "lucide-react";

export default function Staking() {
  const { wallet } = useWallet();
  const qc = useQueryClient();
  const [stakeForm, setStakeForm] = useState({ validator: "", amount: "" });
  const [unstakeForm, setUnstakeForm] = useState({ validator: "", amount: "" });
  const [stakeMsg, setStakeMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [unstakeMsg, setUnstakeMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const address = wallet?.address ?? "";

  const { data: summary } = useGetStakingSummary({
    query: { queryKey: getGetStakingSummaryQueryKey(), refetchInterval: 10000 },
  });
  const { data: validators, isLoading: vLoading } = useListValidators({
    query: { queryKey: getListValidatorsQueryKey(), refetchInterval: 10000 },
  });
  const { data: positions, isLoading: pLoading } = useGetStakePositions(address, {
    query: {
      queryKey: getGetStakePositionsQueryKey(address),
      enabled: !!address,
      refetchInterval: 10000,
    },
  });

  const stakeMutation = useStake({
    mutation: {
      onSuccess: (data) => {
        setStakeMsg({ ok: true, text: `Staked ${formatAmount(data.amount)} EQU to ${truncateHash(data.validator)} at height ${data.effectiveHeight}` });
        setStakeForm({ validator: "", amount: "" });
        qc.invalidateQueries({ queryKey: getGetStakePositionsQueryKey(address) });
        qc.invalidateQueries({ queryKey: getGetStakingSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getListValidatorsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setStakeMsg({ ok: false, text: msg });
      },
    },
  });

  const unstakeMutation = useUnstake({
    mutation: {
      onSuccess: (data) => {
        setUnstakeMsg({ ok: true, text: `Unbonding ${formatAmount(data.amount)} EQU — completes at block ${data.completionHeight}` });
        setUnstakeForm({ validator: "", amount: "" });
        qc.invalidateQueries({ queryKey: getGetStakePositionsQueryKey(address) });
        qc.invalidateQueries({ queryKey: getGetStakingSummaryQueryKey() });
        qc.invalidateQueries({ queryKey: getListValidatorsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setUnstakeMsg({ ok: false, text: msg });
      },
    },
  });

  const handleStake = (e: React.FormEvent) => {
    e.preventDefault();
    setStakeMsg(null);
    if (!address) { setStakeMsg({ ok: false, text: "Connect a wallet first." }); return; }
    const amt = Number(stakeForm.amount);
    if (!stakeForm.validator || !Number.isFinite(amt) || amt <= 0) { setStakeMsg({ ok: false, text: "Enter a valid validator address and a positive amount." }); return; }
    stakeMutation.mutate({ data: { delegator: address, validator: stakeForm.validator, amount: amt } });
  };

  const handleUnstake = (e: React.FormEvent) => {
    e.preventDefault();
    setUnstakeMsg(null);
    if (!address) { setUnstakeMsg({ ok: false, text: "Connect a wallet first." }); return; }
    const amt = Number(unstakeForm.amount);
    if (!unstakeForm.validator || !Number.isFinite(amt) || amt <= 0) { setUnstakeMsg({ ok: false, text: "Enter a valid validator address and a positive amount." }); return; }
    unstakeMutation.mutate({ data: { delegator: address, validator: unstakeForm.validator, amount: amt } });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Coins className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Staking</h1>
          <p className="text-sm text-muted-foreground mt-1">Bond EQU to validators and earn block rewards</p>
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Bonded", value: `${formatAmount(summary.totalBondedStake)} EQU`, icon: <Coins className="w-4 h-4" /> },
            { label: "Delegated", value: `${formatAmount(summary.totalDelegated)} EQU`, icon: <TrendingUp className="w-4 h-4" /> },
            { label: "Unbonding", value: `${formatAmount(summary.totalUnbonding)} EQU`, icon: <Clock className="w-4 h-4" /> },
            { label: "Active Stakers", value: String(summary.activeStakers), icon: <Shield className="w-4 h-4" /> },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {s.icon}
                  <span className="text-xs font-medium uppercase tracking-wide">{s.label}</span>
                </div>
                <p className="text-xl font-bold">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Bond / Unbond forms */}
        <div className="lg:col-span-1 space-y-4">
          {!wallet && (
            <Alert>
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription>
                <Link href="/wallet" className="underline text-primary">Connect a wallet</Link> to stake or unstake.
              </AlertDescription>
            </Alert>
          )}
          {wallet && (
            <Card>
              <CardContent className="pt-4 pb-2 text-xs text-muted-foreground font-mono break-all">
                Connected: <span className="text-foreground">{address}</span>
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="bond">
            <TabsList className="w-full">
              <TabsTrigger value="bond" className="flex-1">Bond</TabsTrigger>
              <TabsTrigger value="unbond" className="flex-1">Unbond</TabsTrigger>
            </TabsList>

            <TabsContent value="bond">
              <Card>
                <CardHeader><CardTitle className="text-base">Bond EQU</CardTitle></CardHeader>
                <CardContent>
                  <form onSubmit={handleStake} className="space-y-3">
                    <div>
                      <Label htmlFor="sv">Validator address</Label>
                      <Input id="sv" placeholder="40-char hex" value={stakeForm.validator}
                        onChange={(e) => setStakeForm((p) => ({ ...p, validator: e.target.value }))} />
                    </div>
                    <div>
                      <Label htmlFor="sa">Amount (EQU)</Label>
                      <Input id="sa" type="number" min="1" placeholder="0" value={stakeForm.amount}
                        onChange={(e) => setStakeForm((p) => ({ ...p, amount: e.target.value }))} />
                    </div>
                    {stakeMsg && (
                      <div className={`flex items-start gap-2 text-sm p-2 rounded ${stakeMsg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
                        {stakeMsg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                        {stakeMsg.text}
                      </div>
                    )}
                    <Button type="submit" className="w-full" disabled={stakeMutation.isPending || !wallet}>
                      {stakeMutation.isPending ? "Bonding…" : "Bond"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="unbond">
              <Card>
                <CardHeader><CardTitle className="text-base">Unbond EQU</CardTitle></CardHeader>
                <CardContent>
                  <form onSubmit={handleUnstake} className="space-y-3">
                    <div>
                      <Label htmlFor="uv">Validator address</Label>
                      <Input id="uv" placeholder="40-char hex" value={unstakeForm.validator}
                        onChange={(e) => setUnstakeForm((p) => ({ ...p, validator: e.target.value }))} />
                    </div>
                    <div>
                      <Label htmlFor="ua">Amount (EQU)</Label>
                      <Input id="ua" type="number" min="1" placeholder="0" value={unstakeForm.amount}
                        onChange={(e) => setUnstakeForm((p) => ({ ...p, amount: e.target.value }))} />
                    </div>
                    <p className="text-xs text-muted-foreground">Unbonding period: 10 blocks</p>
                    {unstakeMsg && (
                      <div className={`flex items-start gap-2 text-sm p-2 rounded ${unstakeMsg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
                        {unstakeMsg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
                        {unstakeMsg.text}
                      </div>
                    )}
                    <Button type="submit" variant="outline" className="w-full" disabled={unstakeMutation.isPending || !wallet}>
                      {unstakeMutation.isPending ? "Unbonding…" : "Unbond"}
                    </Button>
                  </form>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>

          {/* My positions */}
          {wallet && (
            <Card>
              <CardHeader><CardTitle className="text-base">My Positions</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {pLoading && (
                  <div className="space-y-3">
                    {[...Array(3)].map((_, i) => (
                      <div key={i} className="flex items-center justify-between animate-pulse" style={{ animationDelay: `${i * 60}ms` }}>
                        <div className="space-y-1.5">
                          <div className="h-3 w-32 bg-muted rounded" />
                          <div className="h-3 w-24 bg-muted rounded" />
                        </div>
                        <div className="h-4 w-20 bg-muted rounded" />
                      </div>
                    ))}
                  </div>
                )}
                {positions && positions.positions.length === 0 && positions.unbonding.length === 0 && (
                  <p className="text-muted-foreground">No active positions.</p>
                )}
                {positions?.positions.map((p) => (
                  <div key={p.validator} className="flex items-center justify-between border-b pb-2 last:border-0">
                    <div>
                      <Link href={`/validators/${p.validator}`} className="font-mono text-xs text-primary hover:underline">{truncateHash(p.validator)}</Link>
                      <p className="text-xs text-muted-foreground">Rewards: {formatAmount(p.rewardsEarned)} EQU</p>
                    </div>
                    <span className="font-medium">{formatAmount(p.amount)} EQU</span>
                  </div>
                ))}
                {positions?.unbonding.map((u, i) => (
                  <div key={i} className="flex items-center justify-between text-muted-foreground border-b pb-2 last:border-0">
                    <div>
                      <p className="font-mono text-xs">{truncateHash(u.validator)}</p>
                      <p className="text-xs">Completes @ block {u.completionHeight}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span className="text-sm">{formatAmount(u.amount)} EQU</span>
                    </div>
                  </div>
                ))}
                {positions && (
                  <div className="pt-1 border-t text-xs text-muted-foreground flex justify-between">
                    <span>Bonded</span><span className="font-medium text-foreground">{formatAmount(positions.totalStaked)} EQU</span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Validator list */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Validator Set</CardTitle></CardHeader>
            <CardContent className="p-0">
              {vLoading ? (
                <table className="w-full">
                  <tbody>
                    {[...Array(5)].map((_, i) => (
                      <tr key={i} className="border-b last:border-0">
                        {[...Array(6)].map((__, j) => (
                          <td key={j} className="p-3">
                            <div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Validator</TableHead>
                      <TableHead className="text-right">Bonded</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Uptime</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validators?.validators.map((v) => (
                      <TableRow key={v.address}>
                        <TableCell>
                          <Link href={`/validators/${v.address}`} className="font-semibold text-primary hover:underline">{v.moniker}</Link>
                          <div className="text-xs text-muted-foreground font-mono">{truncateHash(v.address)}</div>
                        </TableCell>
                        <TableCell className="text-right">{formatAmount(v.bondedStake)} EQU</TableCell>
                        <TableCell className="text-right">{(v.commission * 100).toFixed(0)}%</TableCell>
                        <TableCell className="text-right">{(v.uptime * 100).toFixed(1)}%</TableCell>
                        <TableCell>
                          {v.jailed ? (
                            <Badge variant="outline" className="border-destructive/30 text-destructive bg-destructive/10 text-xs">Jailed</Badge>
                          ) : v.slashed ? (
                            <Badge variant="outline" className="border-orange-200 text-orange-700 bg-orange-50 text-xs">Slashed</Badge>
                          ) : (
                            <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50 text-xs">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" disabled={!wallet || v.jailed}
                            onClick={() => setStakeForm((p) => ({ ...p, validator: v.address }))}>
                            Bond
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
