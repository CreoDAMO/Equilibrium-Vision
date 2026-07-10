import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  GitMerge,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  ShieldAlert,
  Search,
  Users,
  AlertTriangle,
} from "lucide-react";
import { truncateHash, formatAmount } from "@/lib/format";

// ── API types ─────────────────────────────────────────────────────────────────

interface RelayInfo {
  address: string;
  threshold: number;
  relayerCount: number;
  relayers: string[];
}

interface AttestationStatus {
  chainId: string;
  seq: string;
  status: "pending" | "finalized" | "challenged";
  commitment: string | null;
  signers: string[];
  block: number | null;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function attestationBadge(status: AttestationStatus["status"]) {
  switch (status) {
    case "finalized":
      return (
        <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
          <CheckCircle2 className="w-3 h-3 mr-1" /> Finalized
        </Badge>
      );
    case "challenged":
      return (
        <Badge variant="outline" className="border-red-200 text-red-700 bg-red-50">
          <ShieldAlert className="w-3 h-3 mr-1" /> Challenged
        </Badge>
      );
    case "pending":
    default:
      return (
        <Badge variant="outline" className="border-amber-200 text-amber-700 bg-amber-50">
          <Clock className="w-3 h-3 mr-1" /> Pending
        </Badge>
      );
  }
}

// ── Registered relayers table ─────────────────────────────────────────────────

function RelayersCard({ info, isFetching, onRefresh }: {
  info: RelayInfo;
  isFetching: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Users className="w-4 h-4" /> Registered Relayers
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={isFetching}>
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {info.relayers.length === 0 ? (
          <p className="p-6 text-center text-muted-foreground text-sm">
            No relayers registered yet.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Address</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {info.relayers.map((addr, i) => (
                <TableRow key={addr}>
                  <TableCell className="text-muted-foreground text-sm w-12">{i + 1}</TableCell>
                  <TableCell className="font-mono text-sm">{addr}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── Attestation lookup ────────────────────────────────────────────────────────

function AttestationLookup() {
  const [chainId, setChainId] = useState("");
  const [seq, setSeq] = useState("");
  const [query, setQuery] = useState<{ chainId: string; seq: string } | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["relay", "attestation", query?.chainId, query?.seq],
    queryFn: () =>
      customFetch<AttestationStatus>(`/api/relay/attest/inbound/${query!.chainId}/${query!.seq}`),
    enabled: query !== null,
    retry: false,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const c = chainId.trim();
    const s = seq.trim();
    if (!c || !s) return;
    setQuery({ chainId: c, seq: s });
  };

  const errorMsg =
    isError && error instanceof Error ? error.message : isError ? "Attestation not found." : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Search className="w-4 h-4" /> Attestation Lookup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label>Chain ID</Label>
            <Input
              placeholder="e.g. cosmoshub-4"
              value={chainId}
              onChange={(e) => setChainId(e.target.value)}
              className="mt-1 text-sm font-mono"
            />
          </div>
          <div>
            <Label>Sequence</Label>
            <Input
              placeholder="e.g. 1"
              value={seq}
              onChange={(e) => setSeq(e.target.value)}
              className="mt-1 text-sm"
            />
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={isLoading}>
            {isLoading ? "Looking up…" : "Look up"}
          </Button>
        </form>

        {errorMsg && (
          <Alert variant="destructive">
            <AlertTriangle className="w-4 h-4" />
            <AlertDescription className="text-sm">{errorMsg}</AlertDescription>
          </Alert>
        )}

        {data && (
          <div className="space-y-3 border-t pt-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Status</span>
              {attestationBadge(data.status)}
            </div>

            <div>
              <p className="text-xs text-muted-foreground mb-0.5">Chain / Seq</p>
              <p className="text-sm font-mono">
                {data.chainId} / {data.seq}
              </p>
            </div>

            {data.commitment && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Commitment</p>
                <p className="text-sm font-mono break-all">{data.commitment}</p>
              </div>
            )}

            {data.block !== null && (
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Submitted at block</p>
                <p className="text-sm font-mono">{data.block}</p>
              </div>
            )}

            {data.signers.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  Signers ({data.signers.length})
                </p>
                <div className="space-y-1">
                  {data.signers.map((s) => (
                    <p key={s} className="text-xs font-mono flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3 text-green-600 shrink-0" />
                      {s}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RelayPage() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["relay", "info"],
    queryFn: () => customFetch<RelayInfo>("/api/relay/info"),
    refetchInterval: 15_000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="bg-muted rounded-xl w-14 h-14 animate-pulse" />
          <div className="space-y-2">
            <div className="h-8 w-48 bg-muted rounded animate-pulse" />
            <div className="h-4 w-72 bg-muted rounded animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="h-24 bg-muted/40 rounded-lg animate-pulse"
              style={{ animationDelay: `${i * 60}ms` }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-8 text-center space-y-3">
        <div className="flex justify-center">
          <XCircle className="w-10 h-10 text-destructive" />
        </div>
        <p className="text-destructive font-medium">
          CrossChainRelay contract not deployed or unreachable.
        </p>
        <button onClick={() => refetch()} className="text-sm text-primary hover:underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="bg-primary/10 text-primary p-3 rounded-xl">
            <GitMerge className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Cross-Chain Relay</h1>
            <p className="text-sm text-muted-foreground mt-1 font-mono">{data.address}</p>
          </div>
        </div>
        <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
          <CheckCircle2 className="w-3 h-3 mr-1" /> Active
        </Badge>
      </div>

      {/* ── Stats ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Threshold
            </p>
            <p className="text-2xl font-bold">
              {data.threshold}
              <span className="text-base font-normal text-muted-foreground">
                {" "}of {data.relayerCount}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">signatures required</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Active Relayers
            </p>
            <p className="text-2xl font-bold">{data.relayerCount}</p>
            <p className="text-xs text-muted-foreground mt-0.5">bonded nodes</p>
          </CardContent>
        </Card>

        <Card className="col-span-2 md:col-span-1">
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
              Contract
            </p>
            <p className="text-sm font-mono truncate">{truncateHash(data.address)}</p>
            <p className="text-xs text-muted-foreground mt-0.5">WASM on-chain</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Body ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <RelayersCard info={data} isFetching={isFetching} onRefresh={() => refetch()} />
        </div>
        <div className="lg:col-span-1">
          <AttestationLookup />
        </div>
      </div>
    </div>
  );
}
