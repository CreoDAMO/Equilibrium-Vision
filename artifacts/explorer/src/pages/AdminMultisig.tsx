import React, { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminMultisigInfo,
  useProposeAdminAction,
  useApproveAdminAction,
  useSlashValidator,
  getAdminMultisigProposalStatus,
  getGetAdminMultisigInfoQueryKey,
  useListValidators,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import {
  Shield, ShieldCheck, ShieldAlert, RefreshCw, CheckCircle2, AlertCircle,
  Gavel, ListChecks, Zap, Activity, Server, Radio, Users,
  TrendingDown, Clock, Link2, AlertTriangle,
} from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { signRawMessage } from "@/wallet/crypto";
import { truncateHash, timeAgo, formatAmount } from "@/lib/format";
import { Link } from "wouter";

// ── Types ────────────────────────────────────────────────────────────────────

type SlashReason = "double_sign" | "downtime" | "invalid_block";

interface PendingProposal {
  proposalId: number;
  validatorAddress: string;
  reason: SlashReason;
  createdAt: number;
  approvedByMe?: boolean;
  approved?: boolean;
  executed?: boolean;
}

interface SlashEvent {
  validatorAddress: string;
  reason: string;
  height: number;
  timestamp: number;
  slashCount?: number;
}

interface UnbondingEntry {
  delegator: string;
  validator: string;
  amount: number;
  unbondingHeight: number;
  completionHeight: number;
}

interface FinalityRound {
  height: number;
  blockHash: string;
  votes: Array<{ validatorAddress: string; blockHash: string; height: number; signature: string; timestamp: number }>;
  finalized: boolean;
  votingPower: number;
  totalVotingPower: number;
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "equ_admin_multisig_proposals";
function loadProposals(): PendingProposal[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"); } catch { return []; }
}
function saveProposals(proposals: PendingProposal[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(proposals));
}

const REASON_LABELS: Record<SlashReason, string> = {
  double_sign: "Double signing",
  downtime: "Downtime",
  invalid_block: "Invalid block proposal",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon, highlight }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode;
  icon: React.ReactNode; highlight?: "ok" | "warn" | "bad";
}) {
  const colour = highlight === "bad" ? "text-destructive" : highlight === "warn" ? "text-amber-500" : "text-foreground";
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${colour}`}>{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// ── Chain Health tab ──────────────────────────────────────────────────────────

function ChainHealthTab() {
  const { data: finality, isLoading: fLoading, refetch: refetchFinality } = useQuery<{
    finalizedHeight: number; latestHeight: number; lag: number;
    latestRound: FinalityRound | null; recentRounds: FinalityRound[];
  }>({ queryKey: ["chain-finality"], queryFn: () => fetch("/api/chain/finality").then(r => r.json()), refetchInterval: 10000 });

  const { data: sync, isLoading: sLoading, refetch: refetchSync } = useQuery<{
    localHeight: number; finalizedHeight: number;
    peers: { total: number; connected: number; synced: number; behind: number };
  }>({ queryKey: ["sync-status"], queryFn: () => fetch("/api/sync/status").then(r => r.json()), refetchInterval: 10000 });

  const { data: unbonding, isLoading: uLoading } = useQuery<{
    count: number; total: number; queue: UnbondingEntry[];
  }>({ queryKey: ["admin-unbonding"], queryFn: () => fetch("/api/admin/unbonding").then(r => r.json()), refetchInterval: 15000 });

  const lagBad = (finality?.lag ?? 0) > 10;
  const lagWarn = (finality?.lag ?? 0) > 3;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => { refetchFinality(); refetchSync(); }} disabled={fLoading || sLoading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${fLoading || sLoading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Finalized Height"
          value={fLoading ? "…" : (finality?.finalizedHeight ?? "—")}
          sub={`Latest: ${finality?.latestHeight ?? "—"}`}
          icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
        />
        <StatCard
          label="Finality Lag"
          value={fLoading ? "…" : `${finality?.lag ?? 0} blocks`}
          sub="Blocks behind finalized tip"
          icon={<Clock className="w-4 h-4 text-muted-foreground" />}
          highlight={lagBad ? "bad" : lagWarn ? "warn" : "ok"}
        />
        <StatCard
          label="Peers Connected"
          value={sLoading ? "…" : (sync?.peers.connected ?? "—")}
          sub={`${sync?.peers.synced ?? 0} synced · ${sync?.peers.behind ?? 0} behind`}
          icon={<Link2 className="w-4 h-4 text-primary" />}
          highlight={(sync?.peers.connected ?? 1) === 0 ? "bad" : "ok"}
        />
        <StatCard
          label="Unbonding Queue"
          value={uLoading ? "…" : (unbonding?.count ?? 0)}
          sub={unbonding?.total ? `${formatAmount(unbonding.total)} EQU pending` : "No entries"}
          icon={<TrendingDown className="w-4 h-4 text-muted-foreground" />}
        />
      </div>

      {/* Recent finality rounds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Finality Rounds</CardTitle>
          <CardDescription>BFT-finalized blocks from the last 6 heights</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Height</TableHead>
                <TableHead>Votes</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {fLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(4)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (finality?.recentRounds ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-muted-foreground">No finality rounds yet.</TableCell></TableRow>
              ) : [...(finality?.recentRounds ?? [])].reverse().map((r) => (
                <TableRow key={r.height}>
                  <TableCell className="font-mono text-sm">
                    <Link href={`/blocks/${r.height}`} className="text-primary hover:underline">{r.height}</Link>
                  </TableCell>
                  <TableCell>{Array.isArray(r.votes) ? r.votes.length : (r.votes ?? "—")}</TableCell>
                  <TableCell>
                    {r.totalVotingPower > 0
                      ? `${((r.votingPower / r.totalVotingPower) * 100).toFixed(0)}% VP`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    {r.finalized
                      ? <Badge variant="outline" className="text-emerald-600 border-emerald-600/40">Finalized</Badge>
                      : <Badge variant="outline" className="text-amber-600 border-amber-600/40">Pending</Badge>
                    }
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Unbonding queue */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unbonding Queue</CardTitle>
          <CardDescription>Stakes waiting for the 10-block unbonding period to complete</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Delegator</TableHead>
                <TableHead>Validator</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Queued at</TableHead>
                <TableHead className="text-right">Completes at</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {uLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (unbonding?.queue ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">No entries in the unbonding queue.</TableCell></TableRow>
              ) : (unbonding?.queue ?? []).map((u, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/address/${u.delegator}`} className="text-primary hover:underline">{truncateHash(u.delegator)}</Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/validators/${u.validator}`} className="text-primary hover:underline">{truncateHash(u.validator)}</Link>
                  </TableCell>
                  <TableCell className="text-right font-medium">{formatAmount(u.amount)} EQU</TableCell>
                  <TableCell className="text-right text-muted-foreground">#{u.unbondingHeight}</TableCell>
                  <TableCell className="text-right text-muted-foreground">#{u.completionHeight}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Validators tab ────────────────────────────────────────────────────────────

function ValidatorsTab() {
  const { data: vData, isLoading: vLoading } = useListValidators();
  const { data: slashData, isLoading: slashLoading } = useQuery<{ count: number; events: SlashEvent[] }>({
    queryKey: ["admin-slash-events"],
    queryFn: () => fetch("/api/admin/slash-events").then(r => r.json()),
    refetchInterval: 15000,
  });
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "jailed" | "slashed">("all");

  const validators = vData?.validators ?? [];
  const active = validators.filter(v => !v.slashed && !v.jailed).length;
  const jailed = validators.filter(v => v.jailed && !v.slashed).length;
  const slashed = validators.filter(v => v.slashed).length;

  const filtered = validators.filter(v => {
    if (statusFilter === "active") return !v.slashed && !v.jailed;
    if (statusFilter === "jailed") return v.jailed && !v.slashed;
    if (statusFilter === "slashed") return v.slashed;
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <StatCard label="Active" value={vLoading ? "…" : active} icon={<Shield className="w-4 h-4 text-emerald-600" />} highlight="ok" />
        <StatCard label="Jailed" value={vLoading ? "…" : jailed} icon={<AlertTriangle className="w-4 h-4 text-amber-500" />} highlight={jailed > 0 ? "warn" : "ok"} />
        <StatCard label="Slashed" value={vLoading ? "…" : slashed} icon={<ShieldAlert className="w-4 h-4 text-destructive" />} highlight={slashed > 0 ? "bad" : "ok"} />
      </div>

      {/* Validator table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base">All Validators</CardTitle>
            <CardDescription>Live status for every registered validator</CardDescription>
          </div>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="jailed">Jailed</SelectItem>
              <SelectItem value="slashed">Slashed</SelectItem>
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Validator</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Stake</TableHead>
                <TableHead className="text-right">Uptime</TableHead>
                <TableHead className="text-right">Blocks</TableHead>
                <TableHead className="text-right">Slashes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(6)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="h-16 text-center text-muted-foreground">No validators match this filter.</TableCell></TableRow>
              ) : filtered.map(v => (
                <TableRow key={v.address}>
                  <TableCell>
                    <Link href={`/validators/${v.address}`} className="hover:underline">
                      <div className="font-medium text-sm">{v.moniker}</div>
                      <div className="font-mono text-xs text-muted-foreground">{truncateHash(v.address)}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    {v.slashed
                      ? <Badge variant="destructive">Slashed</Badge>
                      : v.jailed
                        ? <Badge variant="outline" className="text-amber-600 border-amber-600/40">Jailed</Badge>
                        : <Badge variant="outline" className="text-emerald-600 border-emerald-600/40">Active</Badge>
                    }
                  </TableCell>
                  <TableCell className="text-right text-sm">{formatAmount(v.bondedStake)} EQU</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Progress value={(v.uptime ?? 0) * 100} className="w-16 h-1.5" />
                      <span className="text-xs text-muted-foreground w-12 text-right">{((v.uptime ?? 0) * 100).toFixed(1)}%</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-sm">{v.blocksProposed ?? 0}</TableCell>
                  <TableCell className="text-right">
                    <span className={v.slashCount > 0 ? "text-destructive font-medium" : "text-muted-foreground"}>{v.slashCount ?? 0}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Global slash history */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Slash History</CardTitle>
          <CardDescription>All slash events across all validators, newest first</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Validator</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Height</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slashLoading ? (
                [...Array(3)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(4)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (slashData?.events ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={4} className="h-16 text-center text-muted-foreground">No slash events on record.</TableCell></TableRow>
              ) : (slashData?.events ?? []).map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/validators/${e.validatorAddress}`} className="text-primary hover:underline">{truncateHash(e.validatorAddress)}</Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-destructive border-destructive/40">
                      {REASON_LABELS[e.reason as SlashReason] ?? e.reason}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {e.height ? <Link href={`/blocks/${e.height}`} className="text-primary hover:underline">#{e.height}</Link> : "—"}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {e.timestamp ? timeAgo(e.timestamp) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Node tab ──────────────────────────────────────────────────────────────────

function NodeTab() {
  const [gossipType, setGossipType] = useState<string>("all");

  const { data: gossip, isLoading: gLoading, refetch: refetchGossip } = useQuery<{
    count: number; events: Array<{ type: string; height?: number; hash?: string; peer?: string; timestamp?: number; [k: string]: unknown }>;
  }>({
    queryKey: ["gossip-log", gossipType],
    queryFn: () => fetch(`/api/gossip?limit=100${gossipType !== "all" ? `&type=${gossipType}` : ""}`).then(r => r.json()),
    refetchInterval: 8000,
  });

  const { data: stratum, isLoading: stratumLoading } = useQuery<{
    enabled: boolean;
    activeConnections?: number;
    activeSessions?: number;
    rateLimitRejectionsTotal?: number;
    duplicateShareRejectionsTotal?: number;
    connectionCapRejectionsTotal?: number;
    connectionsByIp?: Record<string, number>;
  }>({
    queryKey: ["admin-stratum"],
    queryFn: () => fetch("/api/admin/stratum").then(r => r.json()),
    refetchInterval: 10000,
  });

  const gossipTypes = ["all", ...Array.from(new Set((gossip?.events ?? []).map(e => e.type)))];

  return (
    <div className="space-y-6">
      {/* Stratum mining pool */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-primary" />
            <CardTitle className="text-base">Mining Pool (Stratum v1)</CardTitle>
            {stratum?.enabled
              ? <Badge variant="outline" className="text-emerald-600 border-emerald-600/40 ml-1">Live</Badge>
              : <Badge variant="secondary" className="text-amber-600 bg-amber-500/10 border-amber-500/20 border ml-1">Disabled</Badge>
            }
          </div>
          <CardDescription>
            {stratum?.enabled ? "Live metrics from the active Stratum TCP server." : "Start the API server with STRATUM_PORT set to enable the mining pool."}
          </CardDescription>
        </CardHeader>
        {stratum?.enabled && (
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {[
                { label: "Active Connections", value: stratum.activeConnections ?? 0 },
                { label: "Active Sessions", value: stratum.activeSessions ?? 0 },
                { label: "Rate Limit Rejections", value: stratum.rateLimitRejectionsTotal ?? 0 },
                { label: "Duplicate Share Rejections", value: stratum.duplicateShareRejectionsTotal ?? 0 },
                { label: "Connection Cap Rejections", value: stratum.connectionCapRejectionsTotal ?? 0 },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-lg border bg-muted/20 p-3">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-xl font-bold mt-0.5">{value}</p>
                </div>
              ))}
            </div>
            {Object.keys(stratum.connectionsByIp ?? {}).length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Connections by IP</p>
                <div className="space-y-1">
                  {Object.entries(stratum.connectionsByIp ?? {}).map(([ip, count]) => (
                    <div key={ip} className="flex items-center justify-between text-sm">
                      <span className="font-mono text-xs">{ip}</span>
                      <span className="text-muted-foreground">{count} conn</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Gossip log */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-primary" />
              <CardTitle className="text-base">Gossip Log</CardTitle>
              <Badge variant="secondary">{gossip?.count ?? 0} total</Badge>
            </div>
            <CardDescription className="mt-1">P2P gossip events received by this node — last 100</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Select value={gossipType} onValueChange={setGossipType}>
              <SelectTrigger className="w-36 h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gossipTypes.map(t => (
                  <SelectItem key={t} value={t}>{t === "all" ? "All types" : t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetchGossip()} disabled={gLoading}>
              <RefreshCw className={`w-3.5 h-3.5 ${gLoading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Hash</TableHead>
                <TableHead>From Peer</TableHead>
                <TableHead>Hops / Latency</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {gLoading ? (
                [...Array(5)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((__, j) => (
                      <TableCell key={j}><div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 40}ms` }} /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (gossip?.events ?? []).length === 0 ? (
                <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">No gossip events yet.</TableCell></TableRow>
              ) : (gossip?.events ?? []).map((e, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-xs">{e.type}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.hash ? truncateHash(e.hash as string) : "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.fromPeer ? truncateHash(e.fromPeer as string) : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {e.hops != null ? `${e.hops} hop${(e.hops as number) !== 1 ? "s" : ""}` : "—"}
                    {e.latencyMs != null && <span className="ml-1 text-xs">({e.latencyMs}ms)</span>}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {e.timestamp ? timeAgo(e.timestamp as number) : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Multisig tab (original content) ──────────────────────────────────────────

function MultisigTab() {
  const queryClient = useQueryClient();
  const { data: info, isLoading: infoLoading, error: infoQueryError, refetch: fetchInfo } = useGetAdminMultisigInfo();
  const infoError = infoQueryError ? ((infoQueryError as any)?.error ?? "Failed to load multisig configuration") : "";

  const proposeMutation = useProposeAdminAction();
  const approveMutation = useApproveAdminAction();
  const slashMutation = useSlashValidator();

  const [proposals, setProposals] = useState<PendingProposal[]>(loadProposals());
  const [validatorAddress, setValidatorAddress] = useState("");
  const [reason, setReason] = useState<SlashReason>("downtime");
  const [proposeError, setProposeError] = useState("");
  const [approveState, setApproveState] = useState<Record<number, { ownerIndex: string; privKey: string; error: string; busy: boolean }>>({});
  const [executeState, setExecuteState] = useState<Record<number, { busy: boolean; error: string; done?: boolean }>>({});

  const persist = (next: PendingProposal[]) => { setProposals(next); saveProposals(next); };

  const handlePropose = async () => {
    setProposeError("");
    const addr = validatorAddress.trim().toLowerCase();
    if (addr.length !== 40 || !/^[0-9a-f]{40}$/.test(addr)) {
      setProposeError("Validator address must be 40 hex characters.");
      return;
    }
    try {
      const data = await proposeMutation.mutateAsync();
      persist([{ proposalId: data.proposalId, validatorAddress: addr, reason, createdAt: Date.now() }, ...proposals]);
      setValidatorAddress("");
    } catch (e: any) {
      setProposeError(e?.error ?? e?.message ?? "Failed to create proposal");
    }
  };

  const updateApproveField = (id: number, field: "ownerIndex" | "privKey", value: string) => {
    setApproveState(prev => ({ ...prev, [id]: { ...(prev[id] ?? { ownerIndex: "", privKey: "", error: "", busy: false }), [field]: value } }));
  };

  const handleApprove = async (p: PendingProposal) => {
    const state = approveState[p.proposalId] ?? { ownerIndex: "", privKey: "", error: "", busy: false };
    const ownerIndex = Number(state.ownerIndex);
    if (!Number.isInteger(ownerIndex) || ownerIndex < 0) {
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ...state, error: "Owner index must be a non-negative integer." } }));
      return;
    }
    const privKey = state.privKey.trim();
    if (privKey.length !== 64 || !/^[0-9a-fA-F]+$/.test(privKey)) {
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ...state, error: "Private key must be 64 hex characters." } }));
      return;
    }
    setApproveState(prev => ({ ...prev, [p.proposalId]: { ...state, busy: true, error: "" } }));
    try {
      const message = `equilibrium-multisig-approve:${info?.address}:${p.proposalId}`;
      const { signature, publicKey } = await signRawMessage(privKey, message);
      const data = await approveMutation.mutateAsync({ proposalId: p.proposalId, data: { ownerIndex, pubkey: publicKey, signature } });
      persist(proposals.map(pr => pr.proposalId === p.proposalId ? { ...pr, approvedByMe: true, approved: data.approved && data.thresholdMet ? true : pr.approved } : pr));
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ownerIndex: "", privKey: "", error: "", busy: false } }));
    } catch (e: any) {
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ...state, busy: false, error: e?.error ?? e?.message ?? "Approval failed" } }));
    }
  };

  const handleCheckStatus = async (p: PendingProposal) => {
    try {
      const data = await getAdminMultisigProposalStatus(p.proposalId);
      persist(proposals.map(pr => pr.proposalId === p.proposalId ? { ...pr, approved: data.approved } : pr));
    } catch { /* ignore transient errors */ }
  };

  const handleExecute = async (p: PendingProposal) => {
    setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: true, error: "" } }));
    try {
      await slashMutation.mutateAsync({ addr: p.validatorAddress, data: { reason: p.reason, proposalId: p.proposalId } });
      setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: false, error: "", done: true } }));
      persist(proposals.map(pr => pr.proposalId === p.proposalId ? { ...pr, executed: true } : pr));
    } catch (e: any) {
      setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: false, error: e?.error ?? e?.message ?? "Execution failed" } }));
    }
  };

  return (
    <div className="space-y-6">
      {/* Configuration */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              {info?.configured ? <ShieldCheck className="w-4 h-4 text-green-600" /> : <ShieldAlert className="w-4 h-4 text-muted-foreground" />}
              Configuration
            </CardTitle>
            <CardDescription>Live contract state read from the WASM VM.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => { queryClient.invalidateQueries({ queryKey: getGetAdminMultisigInfoQueryKey() }); fetchInfo(); }} disabled={infoLoading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${infoLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {infoError && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{infoError}</AlertDescription></Alert>}
          {!infoLoading && info && !info.configured && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                No admin multisig is configured. Set <code className="font-mono">ADMIN_MULTISIG_OWNERS</code> and{" "}
                <code className="font-mono">ADMIN_MULTISIG_THRESHOLD</code> to deploy one, then keep it stable across restarts by
                setting <code className="font-mono">ADMIN_MULTISIG_ADDRESS</code>. Until then, slashing falls back to the legacy <code className="font-mono">ADMIN_KEY</code> header.
              </AlertDescription>
            </Alert>
          )}
          {info?.configured && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Contract Address</Label>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm break-all">{info.address}</span>
                  {info.address && <CopyButton text={info.address} />}
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Threshold</Label>
                <Badge variant="secondary">{info.threshold}-of-{info.ownerCount}</Badge>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Owners</Label>
                <div className="text-sm">{info.ownerCount}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Status</Label>
                {info.finalized
                  ? <Badge variant="outline" className="text-green-600 border-green-600/40">Finalized</Badge>
                  : <Badge variant="destructive">Not finalized</Badge>}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Propose */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Gavel className="w-4 h-4 text-muted-foreground" /> Propose Validator Slash</CardTitle>
          <CardDescription>Creates a new on-chain proposal that owners can then approve.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Validator Address</Label>
            <Input value={validatorAddress} onChange={e => setValidatorAddress(e.target.value)} placeholder="40-char hex validator address" className="font-mono text-xs" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Slash Reason</Label>
            <Select value={reason} onValueChange={v => setReason(v as SlashReason)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(Object.keys(REASON_LABELS) as SlashReason[]).map(r => <SelectItem key={r} value={r}>{REASON_LABELS[r]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {proposeError && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{proposeError}</AlertDescription></Alert>}
        </CardContent>
        <CardFooter>
          <Button onClick={handlePropose} disabled={proposeMutation.isPending || !info?.configured}>
            {proposeMutation.isPending ? "Creating…" : "Create Proposal"}
          </Button>
        </CardFooter>
      </Card>

      {/* Proposals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ListChecks className="w-4 h-4 text-muted-foreground" /> Proposals</CardTitle>
          <CardDescription>Tracked locally in this browser. Collect signatures from each owner, then execute once approved.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {proposals.length === 0 && <p className="text-sm text-muted-foreground">No proposals yet.</p>}
          {proposals.map(p => {
            const aState = approveState[p.proposalId] ?? { ownerIndex: "", privKey: "", error: "", busy: false };
            const eState = executeState[p.proposalId] ?? { busy: false, error: "" };
            return (
              <div key={p.proposalId} className="border rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary">#{p.proposalId}</Badge>
                    <span className="font-mono text-xs break-all">{p.validatorAddress}</span>
                    <Badge variant="outline">{REASON_LABELS[p.reason]}</Badge>
                    {p.executed && <Badge className="bg-green-600 hover:bg-green-600">Executed</Badge>}
                    {!p.executed && p.approved && <Badge variant="outline" className="text-green-600 border-green-600/40">Approved</Badge>}
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => handleCheckStatus(p)}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Check status
                  </Button>
                </div>
                {!p.executed && (
                  <div className="grid sm:grid-cols-[100px_1fr_auto] gap-2 items-start">
                    <Input placeholder="Owner idx" value={aState.ownerIndex} onChange={e => updateApproveField(p.proposalId, "ownerIndex", e.target.value)} className="font-mono text-xs" inputMode="numeric" />
                    <Input type="password" placeholder="Owner's 64-char private key (stays in your browser)" value={aState.privKey} onChange={e => updateApproveField(p.proposalId, "privKey", e.target.value)} className="font-mono text-xs" />
                    <Button size="sm" onClick={() => handleApprove(p)} disabled={aState.busy}>{aState.busy ? "Signing…" : "Approve"}</Button>
                  </div>
                )}
                {aState.error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{aState.error}</AlertDescription></Alert>}
                {!p.executed && (
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" onClick={() => handleExecute(p)} disabled={eState.busy}>
                      <Zap className="w-3.5 h-3.5 mr-1.5" />{eState.busy ? "Executing…" : "Execute Slash"}
                    </Button>
                    <span className="text-xs text-muted-foreground">Fails with 403 until the threshold of approvals has been met on-chain.</span>
                  </div>
                )}
                {eState.error && <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertDescription>{eState.error}</AlertDescription></Alert>}
                {eState.done && <Alert><CheckCircle2 className="h-4 w-4 text-green-600" /><AlertDescription>Validator slashed successfully.</AlertDescription></Alert>}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function AdminMultisig() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6" /> Admin Panel
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Chain health, validator management, node diagnostics, and the on-chain multisig slash workflow.
        </p>
      </div>

      <Tabs defaultValue="health">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="health" className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Chain Health
          </TabsTrigger>
          <TabsTrigger value="validators" className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Validators
          </TabsTrigger>
          <TabsTrigger value="node" className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" /> Node
          </TabsTrigger>
          <TabsTrigger value="multisig" className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" /> Multisig
          </TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="mt-6"><ChainHealthTab /></TabsContent>
        <TabsContent value="validators" className="mt-6"><ValidatorsTab /></TabsContent>
        <TabsContent value="node" className="mt-6"><NodeTab /></TabsContent>
        <TabsContent value="multisig" className="mt-6"><MultisigTab /></TabsContent>
      </Tabs>
    </div>
  );
}
