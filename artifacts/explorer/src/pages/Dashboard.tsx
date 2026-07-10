import React from "react";
import { useGetChainStatus, useGetChainStats, useListBlocks, useGetMempool, getGetChainStatusQueryKey, getGetChainStatsQueryKey, getListBlocksQueryKey, getGetMempoolQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Activity, Box, Database, HardDrive, Cpu, Hash, ArrowRight, ArrowRightLeft } from "lucide-react";
import { Link } from "wouter";
import { truncateHash, timeAgo, formatAmount, formatScientific } from "@/lib/format";
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, Legend } from "recharts";

export default function Dashboard() {
  const { data: status, isLoading: statusLoading } = useGetChainStatus({ query: { queryKey: getGetChainStatusQueryKey(), refetchInterval: 10000 } });
  const { data: stats } = useGetChainStats({ query: { queryKey: getGetChainStatsQueryKey(), refetchInterval: 10000 } });
  const { data: recentBlocks, isLoading: blocksLoading } = useListBlocks({ limit: 10 }, { query: { queryKey: getListBlocksQueryKey({ limit: 10 }), refetchInterval: 10000 } });
  const { data: mempool } = useGetMempool({ query: { queryKey: getGetMempoolQueryKey(), refetchInterval: 10000 } });

  // Get recent txs either from latest block or mempool
  const recentTxs = [...(mempool?.transactions || []), ...(recentBlocks?.blocks[0]?.transactions || [])].slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "Network Height", icon: <Box className="w-4 h-4 text-primary" />, value: status ? new Intl.NumberFormat().format(status.height) : null, sub: status ? `Latest: ${truncateHash(status.latestHash)}` : null },
          { label: "Throughput",     icon: <Activity className="w-4 h-4 text-primary" />, value: status ? `${status.tps.toFixed(2)} TPS` : null, sub: status ? `${new Intl.NumberFormat().format(status.totalTxCount)} total txs` : null },
          { label: "Mempool",        icon: <Database className="w-4 h-4 text-primary" />, value: status ? String(status.mempoolSize) : null, sub: status ? `Pressure: ${formatScientific(status.mempoolPressure, 3)}` : null },
          { label: "Consensus",      icon: <Cpu className="w-4 h-4 text-primary" />, value: status ? `${status.validatorCount} Peers` : null, sub: status ? `Residual: ${formatScientific(status.lastResidual, 3)}` : null },
        ].map((card) => (
          <Card key={card.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
              {card.icon}
            </CardHeader>
            <CardContent>
              {statusLoading ? (
                <>
                  <div className="h-8 w-28 bg-muted rounded animate-pulse mb-1" />
                  <div className="h-3 w-40 bg-muted rounded animate-pulse" />
                </>
              ) : (
                <>
                  <div className="text-2xl font-bold">{card.value}</div>
                  <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
                </>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Mempool Size &amp; PoS Residual (Last 20 Blocks)</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            {!stats ? (
              <div className="h-full flex flex-col justify-end gap-2 px-2 pb-4 animate-pulse">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-4 bg-muted rounded" style={{ width: `${100 - i * 14}%`, animationDelay: `${i * 60}ms` }} />
                ))}
              </div>
            ) : stats.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats.slice().reverse()} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                  <XAxis dataKey="height" tick={{ fontSize: 12 }} tickLine={false} axisLine={false} label={{ value: "Block Height", position: "insideBottom", offset: -2, fontSize: 11, fill: "var(--muted-foreground)" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={45} label={{ value: "Mempool", angle: -90, position: "insideLeft", offset: 10, fontSize: 11, fill: "var(--muted-foreground)" }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={70} tickFormatter={(v: number) => formatScientific(v, 2)} label={{ value: "Residual", angle: 90, position: "insideRight", offset: 10, fontSize: 11, fill: "var(--muted-foreground)" }} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', borderRadius: '6px' }}
                    formatter={(value: number, name: string) =>
                      name === "Residual" ? [formatScientific(value, 3), name] : [value, name]
                    }
                  />
                  <Legend verticalAlign="top" height={28} />
                  <Line yAxisId="left" type="monotone" dataKey="mempoolPressure" stroke="var(--primary)" strokeWidth={2} dot={false} name="Mempool Pressure" />
                  <Line yAxisId="right" type="monotone" dataKey="residual" stroke="var(--chart-4)" strokeWidth={2} dot={false} name="Residual" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-muted-foreground">No chart data yet.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Latest Blocks</CardTitle>
            <Link href="/blocks" className="text-sm text-primary hover:underline flex items-center">
              View all <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {blocksLoading
                ? [...Array(4)].map((_, i) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg border bg-muted/20 animate-pulse" style={{ animationDelay: `${i * 60}ms` }}>
                      <div className="flex items-center gap-4">
                        <div className="w-8 h-8 bg-muted rounded" />
                        <div className="space-y-1.5">
                          <div className="h-4 w-24 bg-muted rounded" />
                          <div className="h-3 w-32 bg-muted rounded" />
                        </div>
                      </div>
                      <div className="space-y-1.5 text-right">
                        <div className="h-4 w-10 bg-muted rounded ml-auto" />
                        <div className="h-3 w-14 bg-muted rounded ml-auto" />
                      </div>
                    </div>
                  ))
                : recentBlocks?.blocks.map((block) => (
                    <div key={block.hash} className="flex items-center justify-between p-3 rounded-lg border bg-muted/20">
                      <div className="flex items-center gap-4">
                        <div className="bg-primary/10 text-primary p-2 rounded flex items-center justify-center">
                          <Box className="w-4 h-4" />
                        </div>
                        <div>
                          <Link href={`/blocks/${block.height}`} className="font-semibold hover:underline">
                            Block #{block.height}
                          </Link>
                          <div className="text-xs text-muted-foreground font-mono mt-0.5">
                            {truncateHash(block.hash)}
                          </div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium">{block.txCount} txs</div>
                        <div className="text-xs text-muted-foreground mt-0.5">{timeAgo(block.timestamp)}</div>
                      </div>
                    </div>
                  ))
              }
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Transactions</CardTitle>
            <Link href="/mempool" className="text-sm text-primary hover:underline flex items-center">
              Mempool <ArrowRight className="w-4 h-4 ml-1" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {recentTxs.map((tx) => (
                <div key={tx.hash} className="flex items-center justify-between p-3 rounded-lg border bg-muted/20">
                  <div className="flex items-center gap-4">
                    <div className="bg-muted text-muted-foreground p-2 rounded flex items-center justify-center">
                      <ArrowRightLeft className="w-4 h-4" />
                    </div>
                    <div>
                      <Link href={`/tx/${tx.hash}`} className="font-semibold font-mono text-sm hover:underline">
                        {truncateHash(tx.hash)}
                      </Link>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5 flex items-center gap-1">
                        {truncateHash(tx.from)} → {truncateHash(tx.to)}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-medium text-primary">{formatAmount(tx.amount)} EQU</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{timeAgo(tx.timestamp)}</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
