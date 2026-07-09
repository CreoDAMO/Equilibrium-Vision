import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, Clock, Link2, TrendingDown, RefreshCw } from "lucide-react";
import { formatAmount, timeAgo, truncateHash } from "@/lib/format";
import { Link } from "wouter";

interface FinalityRound {
  height: number;
  blockHash: string;
  votes: Array<{ validatorAddress: string; blockHash: string; height: number; signature: string; timestamp: number }>;
  finalized: boolean;
  votingPower: number;
  totalVotingPower: number;
}

interface UnbondingEntry {
  delegator: string;
  validator: string;
  amount: number;
  unbondingHeight: number;
  completionHeight: number;
}

function StatCard({ label, value, sub, icon, highlight }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  icon: React.ReactNode; highlight?: "ok" | "warn" | "bad";
}) {
  const colour = highlight === "bad" ? "text-destructive" : highlight === "warn" ? "text-amber-500" : "text-foreground";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${colour}`}>{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function ChainHealthTab() {
  const { data: finality, isLoading: fLoading, refetch: refetchFinality } = useQuery<{
    finalizedHeight: number; latestHeight: number; lag: number;
    latestRound: FinalityRound | null; recentRounds: FinalityRound[];
  }>({ queryKey: ["chain-finality"], queryFn: () => fetch("/api/chain/finality").then(r => r.json()), refetchInterval: 10000 });

  const { data: sync, isLoading: sLoading, refetch: refetchSync } = useQuery<{
    localHeight: number; finalizedHeight: number;
    peers: { total: number; connected: number; synced: number; behind: number };
  }>({ queryKey: ["sync-status"], queryFn: () => fetch("/api/sync/status").then(r => r.json()), refetchInterval: 10000 });

  const { data: unbonding, isLoading: uLoading } = useQuery<{
    count: number; total: number; queue: UnbondingEntry[];
  }>({ queryKey: ["admin-unbonding"], queryFn: () => fetch("/api/admin/unbonding").then(r => r.json()), refetchInterval: 15000 });

  const lagBad = (finality?.lag ?? 0) > 10;
  const lagWarn = (finality?.lag ?? 0) > 3;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => { refetchFinality(); refetchSync(); }} disabled={fLoading || sLoading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${fLoading || sLoading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Finalized Height"
          value={fLoading ? "…" : (finality?.finalizedHeight ?? "—")}
          sub={`Latest: ${finality?.latestHeight ?? "—"}`}
          icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
        />
        <StatCard
          label="Finality Lag"
          value={fLoading ? "…" : `${finality?.lag ?? 0} blocks`}
          sub="Blocks behind finalized tip"
          icon={<Clock className="w-4 h-4 text-muted-foreground" />}
          highlight={lagBad ? "bad" : lagWarn ? "warn" : "ok"}
        />
        <StatCard
          label="Peers Connected"
          value={sLoading ? "…" : (sync?.peers.connected ?? "—")}
          sub={`${sync?.peers.synced ?? 0} synced · ${sync?.peers.behind ?? 0} behind`}
          icon={<Link2 className="w-4 h-4 text-primary" />}
          highlight={(sync?.peers.connected ?? 1) === 0 ? "bad" : "ok"}
        />
        <StatCard
          label="Unbonding Queue"
          value={uLoading ? "…" : (unbonding?.count ?? 0)}
          sub={unbonding?.total ? `${formatAmount(unbonding.total)} EQU pending` : "No entries"}
          icon={<TrendingDown className="w-4 h-4 text-muted-foreground" />}
        />
      </div>

      {/* Recent finality rounds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Finality Rounds</CardTitle>
          <CardDescription>BFT-finalized blocks from the last 6 heights</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Height</TableHead>
                <TableHead>Votes</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(4)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (finality?.recentRounds ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-muted-foreground">No finality rounds yet.</TableCell></TableRow>
              ) : [...(finality?.recentRounds ?? [])].reverse().map((r) => (
                <TableRow key={r.height}>
                  <TableCell className="font-mono text-sm">
                    <Link href={`/blocks/${r.height}`} className="text-primary hover:underline">{r.height}</Link>
                  </TableCell>
                  <TableCell>{Array.isArray(r.votes) ? r.votes.length : (r.votes ?? "—")}</TableCell>
                  <TableCell>
                    {r.totalVotingPower > 0
                      ? `${((r.votingPower / r.totalVotingPower) * 100).toFixed(0)}% VP`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {r.finalized
                      ? <Badge variant="outline" className="text-emerald-600 border-emerald-600/40">Finalized</Badge>
                      : <Badge variant="outline" className="text-amber-600 border-amber-600/40">Pending</Badge>
                    }
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Unbonding queue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unbonding Queue</CardTitle>
          <CardDescription>Stakes waiting for the 10-block unbonding period to complete</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Delegator</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Queued at</TableHead>
                <TableHead className="text-right">Completes at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (unbonding?.queue ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">No entries in the unbonding queue.</TableCell></TableRow>
              ) : (unbonding?.queue ?? []).map((u, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/address/${u.delegator}`} className="text-primary hover:underline">{truncateHash(u.delegator)}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/validators/${u.validator}`} className="text-primary hover:underline">{truncateHash(u.validator)}</Link>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(u.amount)} EQU</TableCell>
                  <TableCell className="text-right text-muted-foreground">#{u.unbondingHeight}</TableCell>
                  <TableCell className="text-right text-muted-foreground">#{u.completionHeight}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
