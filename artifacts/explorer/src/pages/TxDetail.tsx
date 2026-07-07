import React from "react";
import { useRoute, Link } from "wouter";
import { useGetTransaction } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { ArrowLeft, ArrowRightLeft, Clock, CheckCircle2, Clock4, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";

export default function TxDetail() {
  const [, params] = useRoute("/tx/:hash");
  const hash = params?.hash || "";
  
  const { data: tx, isLoading, error } = useGetTransaction(hash);

  if (isLoading) return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-4">
        <div className="w-9 h-9 bg-muted rounded animate-pulse" />
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
      </div>
      <div className="rounded-lg border p-6 space-y-8 animate-pulse">
        <div className="pb-6 border-b space-y-2">
          <div className="h-4 w-32 bg-muted rounded" />
          <div className="h-6 w-full bg-muted rounded" />
        </div>
        <div className="grid grid-cols-3 gap-6">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="rounded-xl border p-4 space-y-2">
              <div className="h-4 w-16 bg-muted rounded" />
              <div className="h-5 w-full bg-muted rounded" />
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex justify-between py-2 border-b">
              <div className="h-4 w-20 bg-muted rounded" />
              <div className="h-4 w-24 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  if (error || !tx) return (
    <div className="p-8 text-center">
      <p className="text-destructive font-medium">Transaction not found.</p>
      <button onClick={() => window.location.reload()} className="mt-3 text-sm text-primary hover:underline">Retry</button>
    </div>
  );

  const StatusIcon = tx.status === "confirmed" ? CheckCircle2 : tx.status === "pending" ? Clock4 : XCircle;
  const statusColor = tx.status === "confirmed" ? "text-green-600" : tx.status === "pending" ? "text-yellow-600" : "text-red-600";
  const badgeVariant = tx.status === "confirmed" ? "default" : tx.status === "pending" ? "secondary" : "destructive";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-4 mb-4">
        <Button variant="outline" size="icon" onClick={() => window.history.back()}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
          Transaction Details
        </h1>
      </div>

      <Card>
        <CardContent className="p-6 space-y-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 pb-6 border-b">
            <div>
              <div className="text-sm text-muted-foreground mb-1">Transaction Hash</div>
              <div className="font-mono text-lg break-all flex items-center gap-2">
                {tx.hash}
                <CopyButton text={tx.hash} />
              </div>
            </div>
            <Badge variant={badgeVariant} className="flex items-center gap-1.5 px-3 py-1">
              <StatusIcon className={`w-4 h-4 ${statusColor}`} />
              <span className="capitalize">{tx.status}</span>
            </Badge>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
            <div className="p-4 rounded-xl border bg-muted/30">
              <div className="text-sm text-muted-foreground mb-2">From</div>
              {tx.from === "COINBASE" ? (
                <div className="font-mono font-medium">System (Coinbase)</div>
              ) : (
                <Link href={`/address/${tx.from}`} className="text-primary hover:underline font-mono font-medium break-all">
                  {tx.from}
                </Link>
              )}
            </div>
            
            <div className="flex justify-center">
              <div className="bg-primary/10 text-primary p-3 rounded-full">
                <ArrowRightLeft className="w-6 h-6" />
              </div>
            </div>

            <div className="p-4 rounded-xl border bg-muted/30">
              <div className="text-sm text-muted-foreground mb-2">To</div>
              <Link href={`/address/${tx.to}`} className="text-primary hover:underline font-mono font-medium break-all">
                {tx.to}
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Amount</span>
                <span className="text-xl font-bold">{formatAmount(tx.amount)} EQU</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Fee</span>
                <span>{formatAmount(tx.fee)} EQU</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Nonce</span>
                <span className="font-mono">{tx.nonce}</span>
              </div>
            </div>

            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Block Height</span>
                {tx.blockHeight ? (
                  <Link href={`/blocks/${tx.blockHeight}`} className="text-primary hover:underline font-medium">
                    {tx.blockHeight}
                  </Link>
                ) : (
                  <span className="text-muted-foreground italic">Pending</span>
                )}
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Timestamp</span>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <span>{new Date(tx.timestamp).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex justify-between items-center py-2 border-b">
                <span className="text-muted-foreground">Time Ago</span>
                <span>{timeAgo(tx.timestamp)}</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
