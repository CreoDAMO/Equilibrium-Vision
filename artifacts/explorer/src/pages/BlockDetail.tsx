import React from "react";
import { useRoute, Link } from "wouter";
import { useGetBlock, useGetBlockFees } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { truncateHash, timeAgo, formatAmount, formatScientific } from "@/lib/format";
import { ArrowLeft, Box, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";

export default function BlockDetail() {
  const [, params] = useRoute("/blocks/:hashOrHeight");
  const id = params?.hashOrHeight || "";
  
  const { data: block, isLoading, error } = useGetBlock(id);
  const { data: fees } = useGetBlockFees(id);

  if (isLoading) return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="w-9 h-9 bg-muted rounded animate-pulse" />
        <div className="h-8 w-40 bg-muted rounded animate-pulse" />
      </div>
      <div className="rounded-lg border p-6 space-y-6 animate-pulse">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="flex justify-between py-2 border-b">
              <div className="h-4 w-24 bg-muted rounded" />
              <div className="h-4 w-32 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-lg border overflow-hidden">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-12 bg-muted/40 border-b last:border-0 animate-pulse" style={{ animationDelay: `${i * 60}ms` }} />
        ))}
      </div>
    </div>
  );
  if (error || !block) return (
    <div className="p-8 text-center">
      <p className="text-destructive font-medium">Block not found.</p>
      <button onClick={() => window.location.reload()} className="mt-3 text-sm text-primary hover:underline">Retry</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <Button variant="outline" size="icon" asChild>
          <Link href="/blocks"><ArrowLeft className="w-4 h-4" /></Link>
        </Button>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
          <Box className="w-8 h-8 text-primary" />
          Block #{block.height}
        </h1>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Hash</span>
              <span className="font-mono text-sm flex items-center gap-2">
                {truncateHash(block.hash)}
                <CopyButton text={block.hash} />
              </span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Timestamp</span>
              <span>{new Date(block.timestamp).toLocaleString()} ({timeAgo(block.timestamp)})</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Miner</span>
              <div className="flex items-center gap-2">
                <Link href={`/address/${block.miner}`} className="text-primary hover:underline font-mono text-sm">
                  {truncateHash(block.miner)}
                </Link>
                <CopyButton text={block.miner} />
              </div>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Transactions</span>
              <span>{block.txCount}</span>
            </div>
            <div className="flex justify-between items-center py-2">
              <span className="text-muted-foreground">Reward</span>
              <span className="font-medium">{formatAmount(block.coinbaseReward)} EQU</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Consensus Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Residual Quality</span>
              <Badge variant="outline" className={block.residual < 0.1 ? "bg-green-100 text-green-800" : "bg-yellow-100 text-yellow-800"}>
                {formatScientific(block.residual)}
              </Badge>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Difficulty</span>
              <span>{formatScientific(block.difficulty)}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Recursion Depth</span>
              <span>{block.recursionDepth}</span>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Nonce</span>
              <span className="font-mono text-sm">{block.nonce}</span>
            </div>
            <div className="flex flex-col py-2">
              <span className="text-muted-foreground mb-1">Parent Hash</span>
              <Link href={`/blocks/${block.prevHash}`} className="text-primary hover:underline font-mono text-sm">
                {block.prevHash}
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {fees && (
        <Card>
          <CardHeader>
            <CardTitle>Miner Fee Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1 p-3 rounded-md border">
                <span className="text-xs text-muted-foreground">Coinbase Reward</span>
                <span className="font-medium">{formatAmount(fees.coinbaseReward)} EQU</span>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-md border">
                <span className="text-xs text-muted-foreground">Account-model Fees</span>
                <span className="font-medium">{formatAmount(fees.accountFees.total)} EQU</span>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-md border">
                <span className="text-xs text-muted-foreground">UTXO-model Fees</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{formatAmount(fees.utxoFees.total)} EQU</span>
                  {fees.utxoFees.swept && (
                    <Badge variant="outline" className="bg-green-100 text-green-800 text-xs">swept</Badge>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-md border bg-muted/40">
                <span className="text-xs text-muted-foreground">Total Miner Earnings</span>
                <span className="font-semibold">{formatAmount(fees.totalMinerEarnings)} EQU</span>
              </div>
            </div>

            {fees.accountFees.transactions.length > 0 && (
              <div>
                <p className="text-sm text-muted-foreground mb-2">
                  Account-model fee-paying transactions ({fees.accountFees.txCount})
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tx Hash</TableHead>
                      <TableHead>From</TableHead>
                      <TableHead className="text-right">Fee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fees.accountFees.transactions.map((tx) => (
                      <TableRow key={tx.hash}>
                        <TableCell>
                          <Link href={`/tx/${tx.hash}`} className="text-primary hover:underline font-mono text-sm">
                            {truncateHash(tx.hash)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link href={`/address/${tx.from}`} className="text-primary hover:underline font-mono text-sm">
                            {truncateHash(tx.from)}
                          </Link>
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground">{formatAmount(tx.fee)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {fees.utxoFees.total === 0 && fees.accountFees.total === 0 && (
              <p className="text-sm text-muted-foreground">No transaction fees were collected in this block.</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hash</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Fee</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.transactions.map((tx) => (
                <TableRow key={tx.hash}>
                  <TableCell className="font-medium">
                    <Link href={`/tx/${tx.hash}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(tx.hash)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {tx.from === "COINBASE" ? (
                      <span className="text-muted-foreground font-mono text-sm">COINBASE</span>
                    ) : (
                      <Link href={`/address/${tx.from}`} className="text-primary hover:underline font-mono text-sm">
                        {truncateHash(tx.from)}
                      </Link>
                    )}
                  </TableCell>
                  <TableCell>
                    <Link href={`/address/${tx.to}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(tx.to)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(tx.amount)} EQU</TableCell>
                  <TableCell className="text-right text-muted-foreground">{formatAmount(tx.fee)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
