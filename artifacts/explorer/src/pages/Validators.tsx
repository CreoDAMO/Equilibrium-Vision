import React from "react";
import { Link } from "wouter";
import { useListValidators, getListValidatorsQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatAmount, truncateHash } from "@/lib/format";

export default function Validators() {
  const { data, isLoading, error } = useListValidators({
    query: { queryKey: getListValidatorsQueryKey(), refetchInterval: 10000 },
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading validators...</div>;
  if (error || !data) return <div className="p-8 text-center text-destructive">Failed to load validators.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Shield className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Validators</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data.count} validators &middot; {formatAmount(data.totalBondedStake)} EQU total bonded stake
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Validator Set</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Validator</TableHead>
                <TableHead className="text-right">Bonded Stake</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Commission</TableHead>
                <TableHead className="text-right">Blocks Proposed</TableHead>
                <TableHead className="text-right">Uptime</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.validators.map((v) => (
                <TableRow key={v.address}>
                  <TableCell>
                    <Link href={`/validators/${v.address}`} className="font-semibold text-primary hover:underline">
                      {v.moniker}
                    </Link>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">{truncateHash(v.address)}</div>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(v.bondedStake)} EQU</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Progress value={v.sharePercent} className="w-16 h-1.5" />
                      <span className="text-sm text-muted-foreground w-12 text-right">{v.sharePercent.toFixed(1)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{(v.commission * 100).toFixed(0)}%</TableCell>
                  <TableCell className="text-right text-muted-foreground">{v.blocksProposed}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{(v.uptime * 100).toFixed(1)}%</TableCell>
                  <TableCell>
                    {v.jailed ? (
                      <Badge variant="outline" className="border-destructive/30 text-destructive bg-destructive/10">
                        <ShieldAlert className="w-3 h-3 mr-1" /> Jailed
                      </Badge>
                    ) : v.slashed ? (
                      <Badge variant="outline" className="border-orange-200 text-orange-700 bg-orange-50">
                        <ShieldAlert className="w-3 h-3 mr-1" /> Slashed
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
                        <ShieldCheck className="w-3 h-3 mr-1" /> Active
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data.validators.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No validators found.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
