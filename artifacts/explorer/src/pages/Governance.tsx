import React, { useState } from "react";
import { Link } from "wouter";
import {
  useListProposals,
  useGetChainParameters,
  useCreateProposal,
  useVoteOnProposal,
  getListProposalsQueryKey,
  getGetChainParametersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Vote, CheckCircle2, XCircle, Clock, Zap } from "lucide-react";
import { formatAmount } from "@/lib/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  switch (status) {
    case "active":
      return (
        <Badge variant="outline" className="border-blue-200 text-blue-700 bg-blue-50">
          <Clock className="w-3 h-3 mr-1" /> Active
        </Badge>
      );
    case "passed":
      return (
        <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
          <CheckCircle2 className="w-3 h-3 mr-1" /> Passed
        </Badge>
      );
    case "executed":
      return (
        <Badge variant="outline" className="border-purple-200 text-purple-700 bg-purple-50">
          <Zap className="w-3 h-3 mr-1" /> Executed
        </Badge>
      );
    case "rejected":
    default:
      return (
        <Badge variant="outline" className="border-red-200 text-red-700 bg-red-50">
          <XCircle className="w-3 h-3 mr-1" /> Rejected
        </Badge>
      );
  }
}

function VoteBar({ yes, no, abstain }: { yes: number; no: number; abstain: number }) {
  const total = yes + no + abstain;
  if (total === 0) return <span className="text-xs text-muted-foreground">No votes yet</span>;
  const yesPct = (yes / total) * 100;
  const noPct = (no / total) * 100;
  const abstainPct = (abstain / total) * 100;
  return (
    <div className="space-y-1">
      <div className="flex h-2 rounded-full overflow-hidden bg-muted w-full">
        <div className="bg-green-500 transition-all" style={{ width: `${yesPct}%` }} />
        <div className="bg-red-400 transition-all" style={{ width: `${noPct}%` }} />
        <div className="bg-gray-300 transition-all" style={{ width: `${abstainPct}%` }} />
      </div>
      <div className="flex gap-3 text-xs text-muted-foreground">
        <span className="text-green-600">Yes {yesPct.toFixed(0)}%</span>
        <span className="text-red-500">No {noPct.toFixed(0)}%</span>
        <span>Abstain {abstainPct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

// ── New Proposal Form ─────────────────────────────────────────────────────────

function NewProposalForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    proposer: "",
    type: "text" as "text" | "parameter_change",
    title: "",
    description: "",
    paramKey: "",
    paramValue: "",
  });
  const qc = useQueryClient();
  const create = useCreateProposal();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await create.mutateAsync({
        data: {
          proposer: form.proposer,
          type: form.type,
          title: form.title,
          description: form.description,
          ...(form.type === "parameter_change" && form.paramKey
            ? { parameterChange: { key: form.paramKey, value: Number(form.paramValue) } }
            : {}),
        },
      });
      await qc.invalidateQueries({ queryKey: getListProposalsQueryKey() });
      setOpen(false);
      setForm({ proposer: "", type: "text", title: "", description: "", paramKey: "", paramValue: "" });
      onCreated();
    } catch {
      // error shown by mutation state
    }
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm">
        <Vote className="w-4 h-4 mr-2" /> New Proposal
      </Button>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Submit Governance Proposal</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Proposer address</label>
              <Input
                required
                placeholder="Your wallet address (40 hex chars)"
                value={form.proposer}
                onChange={e => setForm(f => ({ ...f, proposer: e.target.value }))}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm bg-background"
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value as "text" | "parameter_change" }))}
              >
                <option value="text">Text (signal only)</option>
                <option value="parameter_change">Parameter Change</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input
                required
                placeholder="Short proposal title"
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className="mt-1 text-sm"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <textarea
                required
                rows={3}
                placeholder="Describe what this proposal does and why..."
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm bg-background resize-none"
              />
            </div>
            {form.type === "parameter_change" && (
              <>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Parameter key</label>
                  <select
                    className="mt-1 w-full border rounded-md px-3 py-2 text-sm bg-background"
                    value={form.paramKey}
                    onChange={e => setForm(f => ({ ...f, paramKey: e.target.value }))}
                  >
                    <option value="">Select parameter…</option>
                    <option value="baseReward">baseReward</option>
                    <option value="miningThreshold">miningThreshold</option>
                    <option value="unbondingPeriod">unbondingPeriod</option>
                    <option value="maxMempoolSize">maxMempoolSize</option>
                    <option value="minValidatorStake">minValidatorStake</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">New value</label>
                  <Input
                    type="number"
                    step="any"
                    placeholder="New parameter value"
                    value={form.paramValue}
                    onChange={e => setForm(f => ({ ...f, paramValue: e.target.value }))}
                    className="mt-1 text-sm"
                  />
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={create.isPending}>
              {create.isPending ? "Submitting…" : "Submit Proposal"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {create.isError && (
              <span className="text-xs text-destructive self-center">
                {(create.error as Error)?.message ?? "Submission failed"}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Chain Parameters Panel ────────────────────────────────────────────────────

function ChainParamsPanel() {
  const { data } = useGetChainParameters({
    query: { queryKey: getGetChainParametersQueryKey(), refetchInterval: 15000 },
  });

  if (!data) return null;

  const params = [
    { label: "Base Reward", value: `${formatAmount(data.baseReward)} EQU` },
    { label: "Mining Threshold", value: data.miningThreshold.toExponential(2) },
    { label: "Unbonding Period", value: `${data.unbondingPeriod} blocks` },
    { label: "Max Mempool Size", value: data.maxMempoolSize.toLocaleString() },
    { label: "Min Validator Stake", value: `${formatAmount(data.minValidatorStake)} EQU` },
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Live Chain Parameters
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
          {params.map(p => (
            <div key={p.label}>
              <dt className="text-xs text-muted-foreground">{p.label}</dt>
              <dd className="text-sm font-mono font-medium">{p.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function GovernancePage() {
  const { data, isLoading, error, refetch } = useListProposals({
    query: { queryKey: getListProposalsQueryKey(), refetchInterval: 15000 },
  });

  if (isLoading) return <div className="p-8 text-center text-muted-foreground">Loading proposals…</div>;
  if (error || !data) return <div className="p-8 text-center text-destructive">Failed to load governance data.</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 text-primary p-3 rounded-xl">
            <Vote className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Governance</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {data.count} proposal{data.count !== 1 ? "s" : ""} · Quorum: 33.4 % bonded stake · Passes: simple majority
            </p>
          </div>
        </div>
      </div>

      <ChainParamsPanel />

      <NewProposalForm onCreated={refetch} />

      {/* Proposals table */}
      <Card>
        <CardHeader>
          <CardTitle>Proposals</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">ID</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="w-40">Votes</TableHead>
                <TableHead className="text-right">Quorum</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.proposals.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs text-muted-foreground">{p.id}</TableCell>
                  <TableCell>
                    <Link href={`/governance/${p.id}`} className="font-medium text-primary hover:underline">
                      {p.title}
                    </Link>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-xs">
                      {p.proposer}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs capitalize">
                      {p.type.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <VoteBar yes={p.votesYes} no={p.votesNo} abstain={p.votesAbstain} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Progress value={Math.min(p.quorumPct, 100)} className="w-16 h-1.5" />
                      <span className="text-xs text-muted-foreground w-12 text-right">
                        {p.quorumPct.toFixed(1)}%
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{statusBadge(p.status)}</TableCell>
                </TableRow>
              ))}
              {data.proposals.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No proposals yet. Submit the first one above.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
