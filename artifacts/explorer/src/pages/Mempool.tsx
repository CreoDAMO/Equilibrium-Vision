import React, { useState } from "react";
import { useGetMempool, getGetMempoolQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Link } from "wouter";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { ListTree, Flame, ArrowUpDown } from "lucide-react";
import { BroadcastDialog } from "@/components/BroadcastDialog";

export default function MempoolPage() {
  const { data: mempool, isLoading } = useGetMempool({ query: { queryKey: getGetMempoolQueryKey(), refetchInterval: 5000 } });
  const [sortField, setSortField] = useState<"timestamp" | "amount" | "fee">("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

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
                <TableRow>
                  <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Loading mempool...</TableCell>
                </TableRow>
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
              {sortedTxs.length === 0 && (
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
