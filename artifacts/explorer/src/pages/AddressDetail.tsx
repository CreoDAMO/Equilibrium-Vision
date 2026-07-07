import React from "react";
import { useRoute, Link } from "wouter";
import { useGetAddress } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { Wallet, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock4 } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

export default function AddressDetail() {
  const [, params] = useRoute("/address/:addr");
  const addr = params?.addr || "";
  
  const { data: info, isLoading, error } = useGetAddress(addr);

  if (isLoading) return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-muted rounded-xl w-14 h-14 animate-pulse" />
        <div className="space-y-2">
          <div className="h-8 w-32 bg-muted rounded animate-pulse" />
          <div className="h-4 w-80 bg-muted rounded animate-pulse" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-lg border p-6 space-y-2 animate-pulse">
            <div className="h-4 w-24 bg-muted rounded" />
            <div className="h-9 w-32 bg-muted rounded" />
          </div>
        ))}
      </div>
      <div className="rounded-lg border overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-16 bg-muted/40 border-b last:border-0 animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    </div>
  );
  if (error || !info) return (
    <div className="p-8 text-center">
      <p className="text-destructive font-medium">Address not found.</p>
      <button onClick={() => window.location.reload()} className="mt-3 text-sm text-primary hover:underline">Retry</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Wallet className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Address</h1>
          <div className="text-sm text-muted-foreground font-mono mt-1 flex items-center gap-2">
            {info.address}
            <CopyButton text={info.address} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{formatAmount(info.balance)} EQU</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{info.txCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Nonce</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{info.nonce}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transaction History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tx Hash</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Counterparty</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {info.transactions.map((tx) => {
                const isOut = tx.from === addr;
                return (
                  <TableRow key={tx.hash}>
                    <TableCell className="font-medium">
                      <Link href={`/tx/${tx.hash}`} className="text-primary hover:underline font-mono text-sm">
                        {truncateHash(tx.hash)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={isOut ? "border-orange-200 text-orange-700 bg-orange-50" : "border-green-200 text-green-700 bg-green-50"}>
                        {isOut ? <ArrowUpRight className="w-3 h-3 mr-1" /> : <ArrowDownRight className="w-3 h-3 mr-1" />}
                        {isOut ? "OUT" : "IN"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {tx.from === "COINBASE" && !isOut ? (
                        <span className="text-muted-foreground font-mono text-sm">COINBASE</span>
                      ) : (
                        <Link href={`/address/${isOut ? tx.to : tx.from}`} className="text-primary hover:underline font-mono text-sm">
                          {truncateHash(isOut ? tx.to : tx.from)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${isOut ? "text-orange-600" : "text-green-600"}`}>
                      {isOut ? "-" : "+"}{formatAmount(tx.amount)} EQU
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {isOut ? formatAmount(tx.fee) : "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-sm">
                        {tx.status === "confirmed" ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                        ) : (
                          <Clock4 className="w-4 h-4 text-yellow-500" />
                        )}
                        <span className="capitalize">{tx.status}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground whitespace-nowrap">
                      {timeAgo(tx.timestamp)}
                    </TableCell>
                  </TableRow>
                );
              })}
              {info.transactions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No transactions found for this address.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
