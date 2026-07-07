import React from "react";
import { useRoute, Link } from "wouter";
import { useGetValidator, useGetValidatorDelegators, useGetValidatorFees, getGetValidatorQueryKey, getGetValidatorDelegatorsQueryKey, getGetValidatorFeesQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { formatAmount, truncateHash, timeAgo } from "@/lib/format";
import { CopyButton } from "@/components/CopyButton";
import { Shield, ShieldAlert, ShieldCheck, Users, TrendingUp, AlertTriangle, Coins } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid } from "recharts";

export default function ValidatorDetail() {
  const [, params] = useRoute("/validators/:addr");
  const addr = params?.addr || "";

  const { data: validator, isLoading, error } = useGetValidator(addr, {
    query: { queryKey: getGetValidatorQueryKey(addr), refetchInterval: 10000 },
  });
  const { data: delegatorsData, isLoading: delegatorsLoading } = useGetValidatorDelegators(addr, {
    query: { queryKey: getGetValidatorDelegatorsQueryKey(addr), refetchInterval: 10000 },
  });
  const { data: feesData, isLoading: feesLoading } = useGetValidatorFees(addr, {
    query: { queryKey: getGetValidatorFeesQueryKey(addr), refetchInterval: 10000, enabled: !!addr },
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading validator...</div>;
  if (error || !validator) return <div className="p-8 text-center text-destructive">Validator not found.</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Shield className="w-8 h-8" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{validator.moniker}</h1>
            {validator.jailed ? (
              <Badge variant="outline" className="border-destructive/30 text-destructive bg-destructive/10">
                <ShieldAlert className="w-3 h-3 mr-1" /> Jailed
              </Badge>
            ) : validator.slashed ? (
              <Badge variant="outline" className="border-orange-200 text-orange-700 bg-orange-50">
                <ShieldAlert className="w-3 h-3 mr-1" /> Slashed
              </Badge>
            ) : (
              <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
                <ShieldCheck className="w-3 h-3 mr-1" /> Active
              </Badge>
            )}
          </div>
          <div className="text-sm text-muted-foreground font-mono mt-1 flex items-center gap-2">
            {validator.address}
            <CopyButton text={validator.address} />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Bonded Stake</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatAmount(validator.bondedStake)} EQU</div>
            <p className="text-xs text-muted-foreground mt-1">{validator.sharePercent.toFixed(2)}% of network</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Accumulated Rewards</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatAmount(validator.accumulatedRewards)} EQU</div>
            <p className="text-xs text-muted-foreground mt-1">{(validator.commission * 100).toFixed(0)}% commission</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Blocks Proposed / Voted</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{validator.blocksProposed} / {validator.blocksVoted}</div>
            <p className="text-xs text-muted-foreground mt-1">Uptime: {(validator.uptime * 100).toFixed(1)}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Slash Count</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{validator.slashCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Double-sign: 5% burn &middot; Downtime: 1% burn</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="fees">Fee Earnings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Users className="w-4 h-4" /> Delegators
              </CardTitle>
              <span className="text-sm text-muted-foreground">
                {delegatorsData ? `${delegatorsData.count} delegators \u00b7 ${formatAmount(delegatorsData.totalDelegated)} EQU delegated` : ""}
              </span>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Delegator</TableHead>
                    <TableHead className="text-right">Live Stake</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Rewards Earned</TableHead>
                    <TableHead className="text-right">Slash Exposure</TableHead>
                    <TableHead className="text-right">Delegated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {delegatorsLoading && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">Loading delegators...</TableCell>
                    </TableRow>
                  )}
                  {!delegatorsLoading && delegatorsData?.delegators.map((d) => (
                    <TableRow key={d.address}>
                      <TableCell>
                        <Link href={`/address/${d.address}`} className="font-mono text-sm text-primary hover:underline">
                          {truncateHash(d.address)}
                        </Link>
                      </TableCell>
                      <TableCell className="text-right font-medium">{formatAmount(d.stakedAmount)} EQU</TableCell>
                      <TableCell className="text-right text-muted-foreground">{d.sharePercent.toFixed(2)}%</TableCell>
                      <TableCell className="text-right text-green-600 flex items-center justify-end gap-1">
                        <TrendingUp className="w-3.5 h-3.5" /> {formatAmount(d.rewardsEarned)} EQU
                      </TableCell>
                      <TableCell className="text-right text-orange-600">
                        <div className="flex items-center justify-end gap-1" title="Amount burned if this validator is slashed">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>
                            {formatAmount(d.slashExposureDoubleSign)} (double-sign) / {formatAmount(d.slashExposureDowntime)} (downtime)
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground whitespace-nowrap">
                        {timeAgo(d.startTimestamp)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!delegatorsLoading && delegatorsData?.delegators.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No delegators for this validator yet.</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {validator.slashHistory.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Slash History</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reason</TableHead>
                      <TableHead className="text-right">Amount Burned</TableHead>
                      <TableHead className="text-right">Height</TableHead>
                      <TableHead className="text-right">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validator.slashHistory.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell className="capitalize">{e.reason.replace("_", " ")}</TableCell>
                        <TableCell className="text-right text-destructive font-medium">{formatAmount(e.slashAmount)} EQU</TableCell>
                        <TableCell className="text-right text-muted-foreground">{e.height}</TableCell>
                        <TableCell className="text-right text-muted-foreground whitespace-nowrap">{timeAgo(e.timestamp)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="fees" className="space-y-6">
          {feesLoading && (
            <div className="p-8 text-center text-muted-foreground">Loading fee earnings...</div>
          )}
          {!feesLoading && feesData && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Fee Income</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatAmount(feesData.totalFees)} EQU</div>
                    <p className="text-xs text-muted-foreground mt-1">Separate from block rewards</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Block Rewards</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatAmount(feesData.totalCoinbaseRewards)} EQU</div>
                    <p className="text-xs text-muted-foreground mt-1">Coinbase across {feesData.blocksMined} blocks</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Total Earnings</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatAmount(feesData.totalEarnings)} EQU</div>
                    <p className="text-xs text-muted-foreground mt-1">Rewards + fees combined</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">Avg Fee / Block</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{formatAmount(feesData.avgFeePerBlock)} EQU</div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatAmount(feesData.totalAccountFees)} account &middot; {formatAmount(feesData.totalUtxoFees)} UTXO
                    </p>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Coins className="w-4 h-4" /> Fee Income Over Time
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {feesData.history.length === 0 ? (
                    <div className="h-24 flex flex-col items-center justify-center gap-2 text-muted-foreground text-sm text-center">
                      <span>No fee-paying transactions have been included in blocks proposed by this validator yet.</span>
                      <span className="text-xs">Earnings will appear here once blocks with transactions are mined.</span>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={feesData.history}>
                        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                        <XAxis dataKey="height" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <RechartsTooltip
                          labelFormatter={(height) => `Block ${height}`}
                          formatter={(value: number, name: string) => [`${formatAmount(value)} EQU`, name]}
                        />
                        <Line type="monotone" dataKey="totalFees" name="Total Fees" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="coinbaseReward" name="Block Reward" stroke="#94a3b8" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Per-Block Fee History</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Block</TableHead>
                        <TableHead className="text-right">Block Reward</TableHead>
                        <TableHead className="text-right">Account Fees</TableHead>
                        <TableHead className="text-right">UTXO Fees</TableHead>
                        <TableHead className="text-right">Total Fees</TableHead>
                        <TableHead className="text-right">Mined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...feesData.history].reverse().slice(0, 50).map((h) => (
                        <TableRow key={h.hash}>
                          <TableCell>
                            <Link href={`/blocks/${h.height}`} className="font-mono text-sm text-primary hover:underline">
                              #{h.height}
                            </Link>
                          </TableCell>
                          <TableCell className="text-right">{formatAmount(h.coinbaseReward)} EQU</TableCell>
                          <TableCell className="text-right">{formatAmount(h.accountFees)} EQU</TableCell>
                          <TableCell className="text-right">{formatAmount(h.utxoFees)} EQU</TableCell>
                          <TableCell className="text-right font-medium text-green-600">{formatAmount(h.totalFees)} EQU</TableCell>
                          <TableCell className="text-right text-muted-foreground whitespace-nowrap">{timeAgo(h.timestamp)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
