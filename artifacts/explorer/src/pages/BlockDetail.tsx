import React from "react";
import { useRoute, Link } from "wouter";
import { useGetBlock } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { ArrowLeft, Box, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";

export default function BlockDetail() {
  const [, params] = useRoute("/blocks/:hashOrHeight");
  const id = params?.hashOrHeight || "";
  
  const { data: block, isLoading, error } = useGetBlock(id);

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading block details...</div>;
  if (error || !block) return <div className="p-8 text-center text-destructive">Block not found.</div>;

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
                {block.residual.toFixed(6)}
              </Badge>
            </div>
            <div className="flex justify-between items-center py-2 border-b">
              <span className="text-muted-foreground">Difficulty</span>
              <span>{block.difficulty}</span>
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
