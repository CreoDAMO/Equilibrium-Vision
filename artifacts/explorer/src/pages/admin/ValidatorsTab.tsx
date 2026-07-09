import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListValidators } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Shield, AlertTriangle, ShieldAlert } from "lucide-react";
import { formatAmount, timeAgo, truncateHash } from "@/lib/format";
import { Link } from "wouter";

type SlashReason = "double_sign" | "downtime" | "invalid_block";

interface SlashEvent {
  validatorAddress: string;
  reason: string;
  height: number;
  timestamp: number;
  slashCount?: number;
}

const REASON_LABELS: Record<SlashReason, string> = {
  double_sign: "Double signing",
  downtime: "Downtime",
  invalid_block: "Invalid block proposal",
};

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

export default function ValidatorsTab() {
  const { data: vData, isLoading: vLoading } = useListValidators();
  const { data: slashData, isLoading: slashLoading } = useQuery<{ count: number; events: SlashEvent[] }>({
    queryKey: ["admin-slash-events"],
    queryFn: () => fetch("/api/admin/slash-events").then(r => r.json()),
    refetchInterval: 15000,
  });
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "jailed" | "slashed">("all");

  const validators = vData?.validators ?? [];
  const active = validators.filter(v => !v.slashed && !v.jailed).length;
  const jailed = validators.filter(v => v.jailed && !v.slashed).length;
  const slashed = validators.filter(v => v.slashed).length;

  const filtered = validators.filter(v => {
    if (statusFilter === "active") return !v.slashed && !v.jailed;
    if (statusFilter === "jailed") return v.jailed && !v.slashed;
    if (statusFilter === "slashed") return v.slashed;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Active" value={vLoading ? "…" : active} icon={<Shield className="w-4 h-4 text-emerald-600" />} highlight="ok" />
        <StatCard label="Jailed" value={vLoading ? "…" : jailed} icon={<AlertTriangle className="w-4 h-4 text-amber-500" />} highlight={jailed > 0 ? "warn" : "ok"} />
        <StatCard label="Slashed" value={vLoading ? "…" : slashed} icon={<ShieldAlert className="w-4 h-4 text-destructive" />} highlight={slashed > 0 ? "bad" : "ok"} />
      </div>

      {/* Validator table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">All Validators</CardTitle>
            <CardDescription>Live status for every registered validator</CardDescription>
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="jailed">Jailed</SelectItem>
              <SelectItem value="slashed">Slashed</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Validator</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Stake</TableHead>
                <TableHead className="text-right">Uptime</TableHead>
                <TableHead className="text-right">Blocks</TableHead>
                <TableHead className="text-right">Slashes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(6)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-16 text-center text-muted-foreground">No validators match this filter.</TableCell></TableRow>
              ) : filtered.map(v => (
                <TableRow key={v.address}>
                  <TableCell>
                    <Link href={`/validators/${v.address}`} className="hover:underline">
                      <div className="font-medium text-sm">{v.moniker}</div>
                      <div className="font-mono text-xs text-muted-foreground">{truncateHash(v.address)}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {v.slashed
                      ? <Badge variant="destructive">Slashed</Badge>
                      : v.jailed
                        ? <Badge variant="outline" className="text-amber-600 border-amber-600/40">Jailed</Badge>
                        : <Badge variant="outline" className="text-emerald-600 border-emerald-600/40">Active</Badge>
                    }
                  </TableCell>
                  <TableCell className="text-right text-sm">{formatAmount(v.bondedStake)} EQU</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Progress value={(v.uptime ?? 0) * 100} className="w-16 h-1.5" />
                      <span className="text-xs text-muted-foreground w-12 text-right">{((v.uptime ?? 0) * 100).toFixed(1)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">{v.blocksProposed ?? 0}</TableCell>
                  <TableCell className="text-right">
                    <span className={v.slashCount > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{v.slashCount ?? 0}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Global slash history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Slash History</CardTitle>
          <CardDescription>All slash events across all validators, newest first</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Validator</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Height</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slashLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(4)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (slashData?.events ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-muted-foreground">No slash events on record.</TableCell></TableRow>
              ) : (slashData?.events ?? []).map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/validators/${e.validatorAddress}`} className="text-primary hover:underline">{truncateHash(e.validatorAddress)}</Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-destructive border-destructive/40">
                      {REASON_LABELS[e.reason as SlashReason] ?? e.reason}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {e.height ? <Link href={`/blocks/${e.height}`} className="text-primary hover:underline">#{e.height}</Link> : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {e.timestamp ? timeAgo(e.timestamp) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
