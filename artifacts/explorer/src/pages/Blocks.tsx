import React, { useState } from "react";
import { useListBlocks, getListBlocksQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { truncateHash, timeAgo, formatAmount, formatScientific } from "@/lib/format";
import { ChevronLeft, ChevronRight } from "lucide-react";

export default function Blocks() {
  const [page, setPage] = useState(1);
  const limit = 20;
  
  const { data, isLoading } = useListBlocks({ page, limit }, { query: { queryKey: getListBlocksQueryKey({ page, limit }), refetchInterval: 10000 } });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Blocks</h1>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Height</TableHead>
                <TableHead>Hash</TableHead>
                <TableHead>Miner</TableHead>
                <TableHead className="text-right">Txs</TableHead>
                <TableHead className="text-right">Reward</TableHead>
                <TableHead className="text-right">Residual</TableHead>
                <TableHead className="text-right">Age</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(10)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(7)].map((__, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 40}ms` }} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data?.blocks.map((block) => (
                <TableRow key={block.hash}>
                  <TableCell className="font-medium">
                    <Link href={`/blocks/${block.height}`} className="text-primary hover:underline">
                      {block.height}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{truncateHash(block.hash)}</TableCell>
                  <TableCell>
                    <Link href={`/address/${block.miner}`} className="text-primary hover:underline font-mono text-sm">
                      {truncateHash(block.miner)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right">{block.txCount}</TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(block.coinbaseReward)} EQU</TableCell>
                  <TableCell className="text-right text-muted-foreground font-mono text-xs">{formatScientific(block.residual, 3)}</TableCell>
                  <TableCell className="text-right text-muted-foreground whitespace-nowrap">{timeAgo(block.timestamp)}</TableCell>
                </TableRow>
              ))}
              {data?.blocks.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No blocks found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          Showing page {page} {data && `of ${Math.ceil(data.total / limit)}`}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Previous
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPage(p => p + 1)} disabled={!data || page >= Math.ceil(data.total / limit)}>
            Next <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}
