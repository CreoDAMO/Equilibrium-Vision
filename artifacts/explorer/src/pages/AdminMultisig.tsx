import React, { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Shield, ShieldCheck, ShieldAlert, RefreshCw, CheckCircle2,
  AlertCircle, Gavel, ListChecks, Zap,
} from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { signRawMessage } from "@/wallet/crypto";

interface MultisigInfo {
  configured: boolean;
  address?: string;
  ownerCount?: number;
  threshold?: number;
  finalized?: boolean;
}

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

const STORAGE_KEY = "equ_admin_multisig_proposals";

function loadProposals(): PendingProposal[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProposals(proposals: PendingProposal[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(proposals));
}

const REASON_LABELS: Record<SlashReason, string> = {
  double_sign: "Double signing",
  downtime: "Downtime",
  invalid_block: "Invalid block proposal",
};

export default function AdminMultisig() {
  const [info, setInfo] = useState<MultisigInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState(true);
  const [infoError, setInfoError] = useState("");

  const [proposals, setProposals] = useState<PendingProposal[]>(loadProposals());

  const [validatorAddress, setValidatorAddress] = useState("");
  const [reason, setReason] = useState<SlashReason>("downtime");
  const [proposing, setProposing] = useState(false);
  const [proposeError, setProposeError] = useState("");

  const [approveState, setApproveState] = useState<Record<number, { ownerIndex: string; privKey: string; error: string; busy: boolean }>>({});
  const [executeState, setExecuteState] = useState<Record<number, { busy: boolean; error: string; done?: boolean }>>({});

  const fetchInfo = useCallback(async () => {
    setInfoLoading(true);
    setInfoError("");
    try {
      const res = await fetch("/api/admin/multisig");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setInfo(data);
    } catch (e: any) {
      setInfoError(e.message ?? "Failed to load multisig configuration");
    } finally {
      setInfoLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  const persist = (next: PendingProposal[]) => {
    setProposals(next);
    saveProposals(next);
  };

  const handlePropose = async () => {
    setProposeError("");
    const addr = validatorAddress.trim().toLowerCase();
    if (addr.length !== 40 || !/^[0-9a-f]{40}$/.test(addr)) {
      setProposeError("Validator address must be 40 hex characters.");
      return;
    }
    setProposing(true);
    try {
      const res = await fetch("/api/admin/multisig/propose", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create proposal");
      const proposal: PendingProposal = {
        proposalId: data.proposalId,
        validatorAddress: addr,
        reason,
        createdAt: Date.now(),
      };
      persist([proposal, ...proposals]);
      setValidatorAddress("");
    } catch (e: any) {
      setProposeError(e.message ?? "Failed to create proposal");
    } finally {
      setProposing(false);
    }
  };

  const updateApproveField = (id: number, field: "ownerIndex" | "privKey", value: string) => {
    setApproveState(prev => ({
      ...prev,
      [id]: { ...(prev[id] ?? { ownerIndex: "", privKey: "", error: "", busy: false }), [field]: value },
    }));
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
      const res = await fetch(`/api/admin/multisig/${p.proposalId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerIndex, pubkey: publicKey, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Approval failed");
      persist(proposals.map(pr => pr.proposalId === p.proposalId
        ? { ...pr, approvedByMe: true, approved: data.approved && data.thresholdMet ? true : pr.approved }
        : pr));
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ownerIndex: "", privKey: "", error: "", busy: false } }));
    } catch (e: any) {
      setApproveState(prev => ({ ...prev, [p.proposalId]: { ...state, busy: false, error: e.message ?? "Approval failed" } }));
    }
  };

  const handleCheckStatus = async (p: PendingProposal) => {
    try {
      const res = await fetch(`/api/admin/multisig/${p.proposalId}`);
      const data = await res.json();
      if (res.ok) {
        persist(proposals.map(pr => pr.proposalId === p.proposalId ? { ...pr, approved: data.approved } : pr));
      }
    } catch {
      // ignore — transient network error, user can retry
    }
  };

  const handleExecute = async (p: PendingProposal) => {
    setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: true, error: "" } }));
    try {
      const res = await fetch(`/api/validators/${p.validatorAddress}/slash`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: p.reason, proposalId: p.proposalId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Execution failed");
      setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: false, error: "", done: true } }));
      persist(proposals.map(pr => pr.proposalId === p.proposalId ? { ...pr, executed: true } : pr));
    } catch (e: any) {
      setExecuteState(prev => ({ ...prev, [p.proposalId]: { busy: false, error: e.message ?? "Execution failed" } }));
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6" /> Admin Multisig
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Propose, approve, and execute privileged admin actions (validator slashing) behind the on-chain M-of-N multisig.
        </p>
      </div>

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
          <Button variant="outline" size="sm" onClick={fetchInfo} disabled={infoLoading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${infoLoading ? "animate-spin" : ""}`} /> Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {infoError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{infoError}</AlertDescription>
            </Alert>
          )}
          {!infoLoading && info && !info.configured && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                No admin multisig is configured. Set <code className="font-mono">ADMIN_MULTISIG_OWNERS</code> and{" "}
                <code className="font-mono">ADMIN_MULTISIG_THRESHOLD</code> to deploy one, then keep it stable across
                restarts by setting <code className="font-mono">ADMIN_MULTISIG_ADDRESS</code> to the logged address.
                Until then, validator slashing falls back to the legacy <code className="font-mono">ADMIN_KEY</code> header.
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
                <div>
                  <Badge variant="secondary">{info.threshold}-of-{info.ownerCount}</Badge>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Owners</Label>
                <div className="text-sm">{info.ownerCount}</div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground uppercase tracking-wider">Status</Label>
                <div>
                  {info.finalized
                    ? <Badge variant="outline" className="text-green-600 border-green-600/40">Finalized</Badge>
                    : <Badge variant="destructive">Not finalized</Badge>}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Propose */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gavel className="w-4 h-4 text-muted-foreground" /> Propose Validator Slash
          </CardTitle>
          <CardDescription>Creates a new on-chain proposal that owners can then approve.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Validator Address</Label>
            <Input
              value={validatorAddress}
              onChange={e => setValidatorAddress(e.target.value)}
              placeholder="40-char hex validator address"
              className="font-mono text-xs"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Slash Reason</Label>
            <Select value={reason} onValueChange={v => setReason(v as SlashReason)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REASON_LABELS) as SlashReason[]).map(r => (
                  <SelectItem key={r} value={r}>{REASON_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {proposeError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{proposeError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={handlePropose} disabled={proposing || !info?.configured}>
            {proposing ? "Creating…" : "Create Proposal"}
          </Button>
        </CardFooter>
      </Card>

      {/* Proposals list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-muted-foreground" /> Proposals
          </CardTitle>
          <CardDescription>Tracked locally in this browser. Collect signatures from each owner, then execute once approved.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {proposals.length === 0 && (
            <p className="text-sm text-muted-foreground">No proposals yet.</p>
          )}
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
                    <Input
                      placeholder="Owner idx"
                      value={aState.ownerIndex}
                      onChange={e => updateApproveField(p.proposalId, "ownerIndex", e.target.value)}
                      className="font-mono text-xs"
                      inputMode="numeric"
                    />
                    <Input
                      type="password"
                      placeholder="Owner's 64-char private key (stays in your browser)"
                      value={aState.privKey}
                      onChange={e => updateApproveField(p.proposalId, "privKey", e.target.value)}
                      className="font-mono text-xs"
                    />
                    <Button size="sm" onClick={() => handleApprove(p)} disabled={aState.busy}>
                      {aState.busy ? "Signing…" : "Approve"}
                    </Button>
                  </div>
                )}
                {aState.error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{aState.error}</AlertDescription>
                  </Alert>
                )}

                {!p.executed && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleExecute(p)}
                      disabled={eState.busy}
                    >
                      <Zap className="w-3.5 h-3.5 mr-1.5" />
                      {eState.busy ? "Executing…" : "Execute Slash"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Fails with 403 until the threshold of approvals has been met on-chain.
                    </span>
                  </div>
                )}
                {eState.error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{eState.error}</AlertDescription>
                  </Alert>
                )}
                {eState.done && (
                  <Alert>
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    <AlertDescription>Validator slashed successfully.</AlertDescription>
                  </Alert>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
