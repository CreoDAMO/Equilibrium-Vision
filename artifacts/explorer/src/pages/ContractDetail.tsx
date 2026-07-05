import React, { useState, useEffect, useCallback } from "react";
import { Link, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/CopyButton";
import { truncateHash } from "@/lib/format";
import {
  Code2,
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Database,
  ArrowLeft,
  Play,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AbiFunction {
  name: string;
  methodId: number;
  inputs: string[];
  outputs: string[];
}

interface ContractDetail {
  address: string;
  deployer: string;
  bytecodeHash: string;
  bytecode: string;
  deployedAt: number;
  callCount: number;
  totalGasUsed: number;
  abi: { functions: AbiFunction[] } | null;
}

// ── Call Panel ────────────────────────────────────────────────────────────────

function CallPanel({
  address,
  fn,
}: {
  address: string;
  fn: AbiFunction;
}) {
  const [args, setArgs] = useState<string[]>(fn.inputs.map(() => "0"));
  const [gasLimit, setGasLimit] = useState("1000000");

  const [result, setResult] = useState<
    | null
    | { ok: true; returnValue: number | null; gasUsed: number; logs: string[] }
    | { ok: false; error: string; gasUsed: number }
  >(null);
  const [loading, setLoading] = useState(false);

  const handleCall = async () => {
    const parsedArgs = args.map(Number);
    const parsedGas = Number(gasLimit);
    if (parsedArgs.some((a) => !Number.isFinite(a))) {
      setResult({ ok: false, error: "All arguments must be finite numbers.", gasUsed: 0 });
      return;
    }
    if (!Number.isFinite(parsedGas) || parsedGas <= 0) {
      setResult({ ok: false, error: "Gas limit must be a positive number.", gasUsed: 0 });
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`/api/contracts/${address}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          methodId: fn.methodId,
          args: parsedArgs,
          gasLimit: parsedGas,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setResult({ ok: true, returnValue: data.returnValue ?? null, gasUsed: data.gasUsed, logs: data.logs ?? [] });
      } else {
        setResult({ ok: false, error: data.error ?? "Call failed", gasUsed: data.gasUsed ?? 0 });
      }
    } catch (err: unknown) {
      setResult({ ok: false, error: err instanceof Error ? err.message : "Network error", gasUsed: 0 });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border rounded-lg p-4 space-y-3 bg-muted/20">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono font-semibold text-sm">{fn.name}</span>
          <Badge variant="outline" className="ml-2 text-xs">method {fn.methodId}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          ({fn.inputs.join(", ") || "void"}) → {fn.outputs.join(", ") || "void"}
        </div>
      </div>

      {fn.inputs.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {fn.inputs.map((type, i) => (
            <div key={i}>
              <label className="text-xs text-muted-foreground mb-1 block">
                arg[{i}]: <span className="font-mono">{type}</span>
              </label>
              <Input
                type="number"
                value={args[i]}
                onChange={(e) => {
                  const next = [...args];
                  next[i] = e.target.value;
                  setArgs(next);
                }}
                className="font-mono text-sm h-8"
              />
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="text-xs text-muted-foreground mb-1 block">Gas limit</label>
          <Input
            type="number"
            value={gasLimit}
            onChange={(e) => setGasLimit(e.target.value)}
            className="font-mono text-sm h-8"
          />
        </div>
        <div className="pt-5">
          <Button size="sm" onClick={handleCall} disabled={loading}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
            Call
          </Button>
        </div>
      </div>

      {result && (
        result.ok ? (
          <div className="text-sm bg-green-50 border border-green-200 rounded-md px-3 py-2 space-y-1">
            <div className="flex items-center gap-2 text-green-700 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" /> Success
            </div>
            <div className="font-mono text-xs text-green-800">
              return: <strong>{result.returnValue ?? "void"}</strong>
            </div>
            <div className="text-xs text-green-700">gas used: {result.gasUsed.toLocaleString()}</div>
            {result.logs.length > 0 && (
              <pre className="text-xs bg-white/60 rounded p-1.5 mt-1 border border-green-200 font-mono">
                {result.logs.join("\n")}
              </pre>
            )}
          </div>
        ) : (
          <div className="text-sm bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2 space-y-1">
            <div className="flex items-center gap-2 text-destructive font-medium">
              <AlertCircle className="w-3.5 h-3.5" /> Failed
            </div>
            <div className="text-xs text-destructive">{result.error}</div>
            {result.gasUsed > 0 && (
              <div className="text-xs text-destructive/70">gas used: {result.gasUsed.toLocaleString()}</div>
            )}
          </div>
        )
      )}
    </div>
  );
}

// ── Raw call panel (no ABI) ───────────────────────────────────────────────────

function RawCallPanel({ address }: { address: string }) {
  const [methodId, setMethodId] = useState("0");
  const [argsStr, setArgsStr] = useState("");
  const [gasLimit, setGasLimit] = useState("1000000");
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCall = async () => {
    setLoading(true);
    setResult(null);
    let args: number[] = [];
    try {
      args = argsStr.trim() ? argsStr.split(",").map((s) => Number(s.trim())) : [];
    } catch {
      setResult("Error: could not parse args");
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/contracts/${address}/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ methodId: Number(methodId), args, gasLimit: Number(gasLimit) }),
      });
      const data = await res.json();
      setResult(JSON.stringify(data, null, 2));
    } catch (err: unknown) {
      setResult(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Method ID</label>
          <Input value={methodId} onChange={(e) => setMethodId(e.target.value)} className="font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Args (comma-separated i32)</label>
          <Input value={argsStr} onChange={(e) => setArgsStr(e.target.value)} placeholder="0, 1, 2…" className="font-mono text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Gas limit</label>
          <Input value={gasLimit} onChange={(e) => setGasLimit(e.target.value)} className="font-mono text-sm" />
        </div>
      </div>
      <Button onClick={handleCall} disabled={loading} size="sm">
        {loading ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Zap className="w-3 h-3 mr-1" />}
        Call
      </Button>
      {result && (
        <pre className="text-xs font-mono bg-muted/50 rounded-md p-3 border overflow-auto max-h-48">
          {result}
        </pre>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ContractDetail() {
  const params = useParams<{ address: string }>();
  const address = params.address ?? "";

  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [storage, setStorage] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!address) return;
    setLoading(true);
    setError(null);
    setContract(null);
    Promise.all([
      fetch(`/api/contracts/${address}`).then((r) => r.json()),
      fetch(`/api/contracts/${address}/storage`).then((r) => r.json()),
    ])
      .then(([detail, stor]) => {
        if (detail.error) throw new Error(detail.error);
        setContract(detail);
        setStorage(stor.storage ?? {});
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load contract");
        setLoading(false);
      });
  }, [address]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading contract…
      </div>
    );
  }

  if (error || !contract) {
    return (
      <div className="max-w-xl mx-auto mt-12 text-center space-y-4">
        <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
        <p className="text-destructive font-medium">{error ?? "Contract not found"}</p>
        <Link href="/contracts">
          <Button variant="outline"><ArrowLeft className="w-4 h-4 mr-2" /> Back to Contracts</Button>
        </Link>
      </div>
    );
  }

  const fns = contract.abi?.functions ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/contracts">
          <Button variant="ghost" size="sm" className="text-muted-foreground">
            <ArrowLeft className="w-4 h-4 mr-1" /> Contracts
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Code2 className="w-8 h-8" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold tracking-tight font-mono truncate">{address}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Smart Contract</p>
        </div>
        <CopyButton text={address} />
      </div>

      {/* Info */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Deployed at block", value: contract.deployedAt },
          { label: "Total calls", value: contract.callCount.toLocaleString() },
          { label: "Total gas used", value: contract.totalGasUsed.toLocaleString() },
          { label: "ABI functions", value: fns.length },
        ].map(({ label, value }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold mt-0.5">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-muted-foreground mb-1">Deployer</p>
          <div className="flex items-center gap-2">
            <Link href={`/address/${contract.deployer}`} className="font-mono text-sm hover:text-primary truncate">
              {contract.deployer}
            </Link>
            <CopyButton text={contract.deployer} />
          </div>
        </CardContent>
      </Card>

      {/* Call interface */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" /> Call Contract
          </CardTitle>
          {fns.length > 0 && (
            <CardDescription>Select a function below to invoke it.</CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {fns.length > 0 ? (
            fns.map((fn) => (
              <CallPanel key={fn.methodId} address={address} fn={fn} />
            ))
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No ABI registered. Use raw call mode:
              </p>
              <RawCallPanel address={address} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* Storage */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" /> Storage
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
          </div>
          <CardDescription>{Object.keys(storage).length} key{Object.keys(storage).length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          {Object.keys(storage).length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-lg">
              Storage is empty.
            </p>
          ) : (
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm font-mono">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Key</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(storage).map(([k, v]) => (
                    <tr key={k} className="hover:bg-muted/20">
                      <td className="px-4 py-2 text-xs text-muted-foreground">{k}</td>
                      <td className="px-4 py-2 text-xs">{String(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Bytecode hash */}
      <Card>
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-muted-foreground mb-1">Bytecode hash</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs text-muted-foreground truncate">{contract.bytecodeHash}</code>
            <CopyButton text={contract.bytecodeHash} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
