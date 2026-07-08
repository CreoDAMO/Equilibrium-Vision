import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListModels,
  useProposeModel,
  useVerifyModel,
  useChallengeModel,
  getListModelsQueryKey,
  type Model,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BrainCircuit, CheckCircle2, XCircle, Clock, ShieldAlert } from "lucide-react";
import { useWallet } from "@/wallet/context";
import { truncateHash, timeAgo } from "@/lib/format";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  switch (status) {
    case "verified":
      return (
        <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
          <CheckCircle2 className="w-3 h-3 mr-1" /> Verified
        </Badge>
      );
    case "slashed":
      return (
        <Badge variant="outline" className="border-red-200 text-red-700 bg-red-50">
          <ShieldAlert className="w-3 h-3 mr-1" /> Slashed
        </Badge>
      );
    case "proposed":
    default:
      return (
        <Badge variant="outline" className="border-blue-200 text-blue-700 bg-blue-50">
          <Clock className="w-3 h-3 mr-1" /> Proposed
        </Badge>
      );
  }
}

function StatusMessage({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return (
    <div className={`flex items-start gap-2 text-sm p-2 rounded ${msg.ok ? "bg-green-50 text-green-700" : "bg-destructive/10 text-destructive"}`}>
      {msg.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
      {msg.text}
    </div>
  );
}

// ── Propose form ──────────────────────────────────────────────────────────────

function ProposeModelForm({ onProposed }: { onProposed: () => void }) {
  const { wallet } = useWallet();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    claimedResidual: "",
    supportHashHex: "",
    inputDim: "",
    hiddenDim: "",
    lambda: "",
    seed: "",
    uri: "",
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const propose = useProposeModel({
    mutation: {
      onSuccess: (data) => {
        if (!data.success) {
          setMsg({ ok: false, text: data.error ?? "Proposal rejected" });
          return;
        }
        setMsg({ ok: true, text: `Model #${data.modelId} proposed.` });
        onProposed();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    propose.mutate({
      data: {
        caller: wallet.address,
        claimedResidual: Number(form.claimedResidual),
        supportHashHex: form.supportHashHex.trim().toLowerCase(),
        inputDim: Number(form.inputDim),
        hiddenDim: Number(form.hiddenDim),
        lambda: Number(form.lambda),
        seed: Number(form.seed),
        uri: form.uri.trim(),
      },
    });
  };

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm">
        <BrainCircuit className="w-4 h-4 mr-2" /> Propose Model
      </Button>
    );
  }

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Propose a Model</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label>Support hash (64-char SHA-256 hex)</Label>
              <Input required placeholder="Commitment hash of the support set" value={form.supportHashHex}
                onChange={(e) => setForm((f) => ({ ...f, supportHashHex: e.target.value }))} className="mt-1 font-mono text-sm" />
            </div>
            <div className="col-span-2">
              <Label>Off-chain URI (max 256 bytes)</Label>
              <Input required placeholder="ipfs://... or https://..." value={form.uri}
                onChange={(e) => setForm((f) => ({ ...f, uri: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label>Claimed residual</Label>
              <Input required type="number" step="any" value={form.claimedResidual}
                onChange={(e) => setForm((f) => ({ ...f, claimedResidual: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label>Lambda</Label>
              <Input required type="number" step="any" value={form.lambda}
                onChange={(e) => setForm((f) => ({ ...f, lambda: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label>Input dim</Label>
              <Input required type="number" value={form.inputDim}
                onChange={(e) => setForm((f) => ({ ...f, inputDim: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label>Hidden dim</Label>
              <Input required type="number" value={form.hiddenDim}
                onChange={(e) => setForm((f) => ({ ...f, hiddenDim: e.target.value }))} className="mt-1 text-sm" />
            </div>
            <div>
              <Label>Seed</Label>
              <Input required type="number" value={form.seed}
                onChange={(e) => setForm((f) => ({ ...f, seed: e.target.value }))} className="mt-1 text-sm" />
            </div>
          </div>
          <StatusMessage msg={msg} />
          <div className="flex gap-2 pt-1">
            <Button type="submit" size="sm" disabled={propose.isPending}>
              {propose.isPending ? "Proposing…" : "Submit Proposal (posts bond)"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Challenge form ────────────────────────────────────────────────────────────

function ChallengeForm({ modelId, onClose, onDone }: { modelId: number; onClose: () => void; onDone: () => void }) {
  const { wallet } = useWallet();
  const [supportData, setSupportData] = useState("[[0,0],[1,1]]");
  const [supportLabels, setSupportLabels] = useState("[0,1]");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const challenge = useChallengeModel({
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Challenge failed" }); return; }
        setMsg({ ok: true, text: data.outcome === "slashed" ? "Challenge succeeded — model slashed." : "Challenge did not disprove the claim; bond forfeited." });
        onDone();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (!wallet?.address) { setMsg({ ok: false, text: "Connect a wallet first." }); return; }
    let data: number[][], labels: number[];
    try {
      data = JSON.parse(supportData);
      labels = JSON.parse(supportLabels);
    } catch {
      setMsg({ ok: false, text: "Support data / labels must be valid JSON arrays." });
      return;
    }
    challenge.mutate({ id: modelId, data: { caller: wallet.address, supportData: data, supportLabels: labels } });
  };

  return (
    <Card className="border-orange-300/50 mt-3">
      <CardHeader className="pb-2"><CardTitle className="text-sm">Challenge Model #{modelId}</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Support data (JSON, [nSupport][inputDim])</Label>
            <textarea rows={3} className="mt-1 w-full border rounded-md px-3 py-2 text-xs font-mono bg-background resize-none"
              value={supportData} onChange={(e) => setSupportData(e.target.value)} />
          </div>
          <div>
            <Label>Support labels (JSON array)</Label>
            <textarea rows={2} className="mt-1 w-full border rounded-md px-3 py-2 text-xs font-mono bg-background resize-none"
              value={supportLabels} onChange={(e) => setSupportLabels(e.target.value)} />
          </div>
          <StatusMessage msg={msg} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={challenge.isPending}>
              {challenge.isPending ? "Challenging…" : "Submit Challenge (posts bond)"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Model row ─────────────────────────────────────────────────────────────────

function ModelRow({ model, onChanged }: { model: Model; onChanged: () => void }) {
  const { wallet } = useWallet();
  const [challenging, setChallenging] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const verify = useVerifyModel({
    mutation: {
      onSuccess: (data) => {
        if (!data.success) { setMsg({ ok: false, text: data.error ?? "Verify failed" }); return; }
        setMsg({ ok: true, text: "Verified." });
        onChanged();
      },
      onError: (err: unknown) => setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }),
    },
  });

  const m = model as unknown as Record<string, string | number>;
  const proposer = String(m["model_proposer"] ?? "");
  const uri = String(m["model_uri"] ?? "");
  const proposedAt = m["model_proposed_at"];
  const bond = m["model_bond"];

  return (
    <>
      <TableRow>
        <TableCell className="font-mono text-xs text-muted-foreground">{model.id}</TableCell>
        <TableCell>
          <div className="font-mono text-xs text-primary truncate max-w-[10rem]">{proposer ? truncateHash(proposer) : "—"}</div>
          {uri && <div className="text-xs text-muted-foreground truncate max-w-[14rem]">{uri}</div>}
        </TableCell>
        <TableCell>{statusBadge(model.status)}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">{bond ?? "—"}</TableCell>
        <TableCell className="text-right text-xs text-muted-foreground">
          {proposedAt ? timeAgo(Number(proposedAt)) : "—"}
        </TableCell>
        <TableCell className="text-right">
          {model.status === "proposed" && (
            <div className="flex gap-1.5 justify-end">
              <Button size="sm" variant="outline" disabled={verify.isPending || !wallet}
                onClick={() => wallet?.address && verify.mutate({ id: model.id, data: { caller: wallet.address } })}>
                {verify.isPending ? "…" : "Verify"}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setChallenging((v) => !v)}>
                Challenge
              </Button>
            </div>
          )}
        </TableCell>
      </TableRow>
      {(challenging || msg) && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/20">
            <StatusMessage msg={msg} />
            {challenging && (
              <ChallengeForm modelId={model.id} onClose={() => setChallenging(false)} onDone={() => { setChallenging(false); onChanged(); }} />
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const { data, isLoading, error, refetch } = useListModels({
    query: { queryKey: getListModelsQueryKey(), refetchInterval: 15000 },
  });
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: getListModelsQueryKey() });

  if (isLoading) return (
    <div className="space-y-6">
      <div className="flex items-center gap-4 mb-4">
        <div className="bg-muted rounded-xl w-14 h-14 animate-pulse" />
        <div className="space-y-2">
          <div className="h-8 w-40 bg-muted rounded animate-pulse" />
          <div className="h-4 w-64 bg-muted rounded animate-pulse" />
        </div>
      </div>
      <div className="rounded-lg border overflow-hidden">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-14 bg-muted/40 border-b last:border-0 animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
        ))}
      </div>
    </div>
  );

  if (error || !data) return (
    <div className="p-8 text-center">
      <p className="text-destructive font-medium">Failed to load models.</p>
      <button onClick={() => refetch()} className="mt-3 text-sm text-primary hover:underline">Retry</button>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 text-primary p-3 rounded-xl">
            <BrainCircuit className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Models</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {data.count} model{data.count !== 1 ? "s" : ""} · Permissionless optimistic oracle — economically gated by bonds
            </p>
          </div>
        </div>
      </div>

      <ProposeModelForm onProposed={invalidate} />

      <Card>
        <CardHeader><CardTitle>Registered Models</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">ID</TableHead>
                <TableHead>Proposer / URI</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Bond</TableHead>
                <TableHead className="text-right">Proposed</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.models.map((m) => (
                <ModelRow key={m.id} model={m} onChanged={invalidate} />
              ))}
              {data.models.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                    No models proposed yet.
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
