import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetMempool, getGetMempoolQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { ListTree, Flame, ArrowUpDown, Cpu, Info, ChevronDown, ChevronUp } from "lucide-react";
import { BroadcastDialog } from "@/components/BroadcastDialog";

interface ApiConfig {
  networkName: string;
  stratumPort: number;
  stratumEnabled: boolean;
}

export default function MempoolPage() {
  const { data: mempool, isLoading } = useGetMempool({ query: { queryKey: getGetMempoolQueryKey(), refetchInterval: 5000 } });
  const { data: config } = useQuery<ApiConfig>({
    queryKey: ["api-config"],
    queryFn: () => fetch("/api/config").then((r) => r.json()),
    staleTime: Infinity,
  });
  const [sortField, setSortField] = useState<"timestamp" | "amount" | "fee">("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showMinerGuide, setShowMinerGuide] = useState(false);

  const toggleSort = (field: "timestamp" | "amount" | "fee") => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  const sortedTxs = mempool?.transactions ? [...mempool.transactions].sort((a, b) => {
    const factor = sortDir === "asc" ? 1 : -1;
    return (a[sortField] - b[sortField]) * factor;
  }) : [];

  const SortHeader = ({ field, label }: { field: "timestamp" | "amount" | "fee", label: string }) => (
    <div 
      className="flex items-center justify-end gap-1 cursor-pointer hover:text-foreground select-none"
      onClick={() => toggleSort(field)}
    >
      {label}
      <ArrowUpDown className={`w-3 h-3 ${sortField === field ? "text-primary" : "text-muted-foreground/50"}`} />
    </div>
  );

  // The Stratum host is the same host as the explorer/API (minus port).
  // We show "this server" when the port isn't configured yet.
  const stratumHost = window.location.hostname;
  const stratumEnabled = config?.stratumEnabled ?? false;
  const stratumPort = config?.stratumPort ?? 3333;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="bg-primary/10 text-primary p-2 rounded-lg">
            <ListTree className="w-6 h-6" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Mempool</h1>
        </div>
        <BroadcastDialog />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{mempool ? mempool.count : "..."}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Network Pressure</CardTitle>
            <Flame className={`w-4 h-4 ${mempool && mempool.pressure > 0.8 ? "text-destructive" : "text-orange-500"}`} />
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="text-3xl font-bold">{mempool ? (mempool.pressure * 100).toFixed(1) : "..."}%</div>
              <Progress value={mempool ? mempool.pressure * 100 : 0} className="flex-1" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Miner connection guide ──────────────────────────────────────────── */}
      <Card>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => setShowMinerGuide((v) => !v)}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Connect Your Miner</CardTitle>
              {stratumEnabled
                ? <Badge variant="secondary" className="text-emerald-600 bg-emerald-500/10 border-emerald-500/20 border">Live</Badge>
                : <Badge variant="secondary" className="text-amber-600 bg-amber-500/10 border-amber-500/20 border">Pool disabled</Badge>
              }
            </div>
            {showMinerGuide
              ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
              : <ChevronDown className="w-4 h-4 text-muted-foreground" />
            }
          </div>
        </CardHeader>

        {showMinerGuide && (
          <CardContent className="space-y-5 pt-0">
            {stratumEnabled ? (
              <>
                <p className="text-sm text-muted-foreground">
                  The Equilibrium mining pool speaks <strong>Stratum v1</strong> over a plain TCP socket.
                  Any Stratum-compatible miner can connect — point it at the address below and use your
                  40-character wallet address as the worker name.
                </p>

                {/* Connection string */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">Pool endpoint</p>
                  <code className="block bg-muted rounded-lg px-4 py-3 text-sm font-mono break-all select-all">
                    stratum+tcp://{stratumHost}:{stratumPort}
                  </code>
                </div>

                {/* Step-by-step */}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Handshake sequence</p>
                  <div className="space-y-3">
                    {[
                      {
                        step: "1. Subscribe",
                        desc: "Opens a session and receives your extraNonce.",
                        json: `→  {"id":1,"method":"mining.subscribe","params":["MinerApp/1.0"]}
←  {"id":1,"result":[[…],"<extraNonce1>",4],"error":null}`,
                      },
                      {
                        step: "2. Authorize",
                        desc: 'Log in with your 40-char wallet address as the worker name. An optional tag after "." identifies the device.',
                        json: `→  {"id":2,"method":"mining.authorize","params":["<addr>.<tag>","x"]}
←  {"id":2,"result":true,"error":null}
←  {"method":"mining.notify","params":[…]}   ← first job`,
                      },
                      {
                        step: "3. Submit",
                        desc: 'Send a solved share. The "residual" field is Equilibrium-specific — it carries the Lagrangian residual from the Proof-of-Stationarity computation. It must be below 1×10⁻⁷.',
                        json: `→  {"id":4,"method":"mining.submit",
      "params":["<addr>.<tag>","<jobId>","<extraNonce2>","<ntime>","<nonce>","<residual>"]}
←  {"id":4,"result":true,"error":null}`,
                      },
                    ].map(({ step, desc, json }) => (
                      <div key={step} className="rounded-lg border bg-muted/30 overflow-hidden">
                        <div className="px-4 py-2 border-b bg-muted/50 flex items-start gap-2">
                          <span className="text-xs font-semibold text-primary">{step}</span>
                          <span className="text-xs text-muted-foreground">{desc}</span>
                        </div>
                        <pre className="px-4 py-3 text-xs font-mono overflow-x-auto text-foreground/80 leading-relaxed whitespace-pre-wrap">{json}</pre>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
                  <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
                  <p>
                    The server re-broadcasts <code className="text-xs bg-blue-500/10 rounded px-1">mining.notify</code> to all
                    connected miners the moment a new block is accepted. Miners should immediately start working on the new job
                    and discard any pending shares for the previous one.
                  </p>
                </div>
              </>
            ) : (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  The Stratum mining pool is <strong>not currently active</strong> on this node. To enable it, start the
                  API server with the <code className="text-xs bg-muted rounded px-1">STRATUM_PORT</code> environment variable set
                  to a free TCP port (e.g. <code className="text-xs bg-muted rounded px-1">STRATUM_PORT=3333</code>).
                </p>
                <p>
                  Once running, miners connect to <code className="text-xs bg-muted rounded px-1">stratum+tcp://&lt;host&gt;:&lt;port&gt;</code> using
                  standard Stratum v1. The Equilibrium extension adds a <code className="text-xs bg-muted rounded px-1">residual</code> field to
                  each <code className="text-xs bg-muted rounded px-1">mining.submit</code> call — this carries the Lagrangian residual from
                  the Proof-of-Stationarity algorithm.
                </p>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Live Transaction Pool</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tx Hash</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right"><SortHeader field="amount" label="Amount" /></TableHead>
                <TableHead className="text-right"><SortHeader field="fee" label="Fee" /></TableHead>
                <TableHead className="text-right"><SortHeader field="timestamp" label="Time in Pool" /></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(6)].map((__, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : sortedTxs.map((tx) => (
                <TableRow key={tx.hash}>
                  <TableCell className="font-medium">
                    <Link href={`/tx/${tx.hash}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(tx.hash)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/address/${tx.from}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(tx.from)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/address/${tx.to}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(tx.to)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(tx.amount)} EQU</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatAmount(tx.fee)}</TableCell>
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap">{timeAgo(tx.timestamp)}</TableCell>
                </TableRow>
              ))}
              {!isLoading && sortedTxs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Mempool is currently empty.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
