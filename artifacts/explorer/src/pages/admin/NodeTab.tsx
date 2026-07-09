import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Radio, Server, RefreshCw } from "lucide-react";
import { timeAgo, truncateHash } from "@/lib/format";

export default function NodeTab() {
  const [gossipType, setGossipType] = useState<string>("all");

  const { data: gossip, isLoading: gLoading, refetch: refetchGossip } = useQuery<{
    count: number; events: Array<{ type: string; height?: number; hash?: string; peer?: string; timestamp?: number; [k: string]: unknown }>;
  }>({
    queryKey: ["gossip-log", gossipType],
    queryFn: () => fetch(`/api/gossip?limit=100${gossipType !== "all" ? `&type=${gossipType}` : ""}`).then(r => r.json()),
    refetchInterval: 8000,
  });

  const { data: stratum, isLoading: stratumLoading } = useQuery<{
    enabled: boolean;
    activeConnections?: number;
    activeSessions?: number;
    rateLimitRejectionsTotal?: number;
    duplicateShareRejectionsTotal?: number;
    connectionCapRejectionsTotal?: number;
    connectionsByIp?: Record<string, number>;
  }>({
    queryKey: ["admin-stratum"],
    queryFn: () => fetch("/api/admin/stratum").then(r => r.json()),
    refetchInterval: 10000,
  });

  const gossipTypes = ["all", ...Array.from(new Set((gossip?.events ?? []).map(e => e.type)))];

  return (
    <div className="space-y-6">
      {/* Stratum mining pool */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-primary" />
            <CardTitle className="text-base">Mining Pool (Stratum v1)</CardTitle>
            {stratum?.enabled
              ? <Badge variant="outline" className="text-emerald-600 border-emerald-600/40 ml-1">Live</Badge>
              : <Badge variant="secondary" className="text-amber-600 bg-amber-500/10 border-amber-500/20 border ml-1">Disabled</Badge>
            }
          </div>
          <CardDescription>
            {stratum?.enabled ? "Live metrics from the active Stratum TCP server." : "Start the API server with STRATUM_PORT set to enable the mining pool."}
          </CardDescription>
        </CardHeader>
        {stratum?.enabled && (
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[
                { label: "Active Connections", value: stratum.activeConnections ?? 0 },
                { label: "Active Sessions", value: stratum.activeSessions ?? 0 },
                { label: "Rate Limit Rejections", value: stratum.rateLimitRejectionsTotal ?? 0 },
                { label: "Duplicate Share Rejections", value: stratum.duplicateShareRejectionsTotal ?? 0 },
                { label: "Connection Cap Rejections", value: stratum.connectionCapRejectionsTotal ?? 0 },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-xl font-bold mt-0.5">{value}</p>
                </div>
              ))}
            </div>
            {Object.keys(stratum.connectionsByIp ?? {}).length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Connections by IP</p>
                <div className="space-y-1">
                  {Object.entries(stratum.connectionsByIp ?? {}).map(([ip, count]) => (
                    <div key={ip} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-xs">{ip}</span>
                      <span className="text-muted-foreground">{count} conn</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Gossip log */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Gossip Log</CardTitle>
              <Badge variant="secondary">{gossip?.count ?? 0} total</Badge>
            </div>
            <CardDescription className="mt-1">P2P gossip events received by this node — last 100</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={gossipType} onValueChange={setGossipType}>
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gossipTypes.map(t => (
                  <SelectItem key={t} value={t}>{t === "all" ? "All types" : t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetchGossip()} disabled={gLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${gLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Hash</TableHead>
                <TableHead>From Peer</TableHead>
                <TableHead>Hops / Latency</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 40}ms` }} /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (gossip?.events ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">No gossip events yet.</TableCell></TableRow>
              ) : (gossip?.events ?? []).map((e, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">{e.type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.hash ? truncateHash(e.hash as string) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.fromPeer ? truncateHash(e.fromPeer as string) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {e.hops != null ? `${e.hops} hop${(e.hops as number) !== 1 ? "s" : ""}` : "—"}
                    {e.latencyMs != null && <span className="ml-1 text-xs">({e.latencyMs as number}ms)</span>}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {e.timestamp ? timeAgo(e.timestamp as number) : "—"}
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
