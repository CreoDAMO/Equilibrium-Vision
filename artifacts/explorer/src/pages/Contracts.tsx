import React, { useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/CopyButton";
import { truncateHash, timeAgo } from "@/lib/format";
import {
  Code2,
  Zap,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronRight,
  FileCode,
  BookOpen,
} from "lucide-react";
import { useWallet } from "@/wallet/context";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AbiFunction {
  name: string;
  methodId: number;
  inputs: string[];
  outputs: string[];
}

interface ContractAbi {
  functions: AbiFunction[];
}

interface ExampleContract {
  name: string;
  description: string;
  wat: string;
  abi: ContractAbi;
}

interface DeployedContract {
  address: string;
  deployer: string;
  bytecodeHash: string;
  deployedAt: number;
  callCount: number;
  totalGasUsed: number;
  abi: ContractAbi | null;
}

// ── WAT compiler (wabt, lazy-loaded) ─────────────────────────────────────────

// wabt uses `export =` (CJS) — under Vite/ESM the callable lands on .default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wabtInstance: any = null;

async function compileWatToHex(watSource: string): Promise<{ hex: string; byteLength: number }> {
  if (!wabtInstance) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import("wabt") as any;
    const loader = mod.default ?? mod;
    wabtInstance = await loader();
  }
  const parsed = wabtInstance.parseWat("contract.wat", watSource, {
    mutable_globals: true,
    sat_float_to_int: true,
    sign_extension: true,
    bulk_memory: false,
  });
  const { buffer } = parsed.toBinary({}) as { buffer: Uint8Array };
  parsed.destroy();
  const hex = Array.from(buffer as Uint8Array)
    .map((b: number) => b.toString(16).padStart(2, "0"))
    .join("");
  return { hex, byteLength: buffer.length };
}

// ── Deploy Tab ────────────────────────────────────────────────────────────────

function DeployTab() {
  const { wallet } = useWallet();
  const [, setLocation] = useLocation();

  const [watSource, setWatSource] = useState("");
  const [abiJson, setAbiJson] = useState("");
  const [deployer, setDeployer] = useState(wallet?.address ?? "");
  const [examples, setExamples] = useState<ExampleContract[]>([]);

  const [compileState, setCompileState] = useState<
    | { status: "idle" }
    | { status: "compiling" }
    | { status: "ok"; hex: string; byteLength: number }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const [deployState, setDeployState] = useState<
    | { status: "idle" }
    | { status: "deploying" }
    | { status: "ok"; address: string }
    | { status: "error"; message: string }
  >({ status: "idle" });

  // Load examples on mount
  useEffect(() => {
    fetch("/api/contracts/examples")
      .then((r) => r.json())
      .then((d) => setExamples(d.examples ?? []))
      .catch(() => {});
  }, []);

  const handleLoadExample = (ex: ExampleContract) => {
    setWatSource(ex.wat);
    setAbiJson(JSON.stringify(ex.abi, null, 2));
    setCompileState({ status: "idle" });
    setDeployState({ status: "idle" });
  };

  const handleCompile = useCallback(async () => {
    if (!watSource.trim()) return;
    setCompileState({ status: "compiling" });
    setDeployState({ status: "idle" });
    try {
      const result = await compileWatToHex(watSource);
      setCompileState({ status: "ok", ...result });
    } catch (err: unknown) {
      setCompileState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [watSource]);

  const handleDeploy = useCallback(async () => {
    if (compileState.status !== "ok") return;
    if (!deployer.trim()) return;

    let abi: ContractAbi | null = null;
    if (abiJson.trim()) {
      try {
        abi = JSON.parse(abiJson);
      } catch {
        setDeployState({ status: "error", message: "ABI is not valid JSON." });
        return;
      }
    }

    setDeployState({ status: "deploying" });
    try {
      const res = await fetch("/api/contracts/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deployer, bytecodeHex: compileState.hex, abi }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setDeployState({ status: "error", message: data.error ?? "Deploy failed." });
      } else {
        setDeployState({ status: "ok", address: data.address });
      }
    } catch (err: unknown) {
      setDeployState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error.",
      });
    }
  }, [compileState, deployer, abiJson]);

  const canCompile = watSource.trim().length > 0;
  const HEX_40 = /^[0-9a-f]{40}$/;
  const canDeploy = compileState.status === "ok" && HEX_40.test(deployer);

  return (
    <div className="space-y-6">
      {/* Examples */}
      {examples.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BookOpen className="w-4 h-4" /> Example Contracts
            </CardTitle>
            <CardDescription>Load a built-in example to get started quickly.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {examples.map((ex) => (
                <Button
                  key={ex.name}
                  variant="outline"
                  size="sm"
                  onClick={() => handleLoadExample(ex)}
                >
                  <FileCode className="w-3 h-3 mr-1.5" />
                  {ex.name}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* WAT editor */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">WAT Source</CardTitle>
            <CardDescription>
              WebAssembly Text Format — paste or type your contract source.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <textarea
              value={watSource}
              onChange={(e) => {
                setWatSource(e.target.value);
                setCompileState({ status: "idle" });
                setDeployState({ status: "idle" });
              }}
              placeholder={`(module\n  (func (export "main") (result i32)\n    i32.const 42\n  )\n)`}
              rows={18}
              spellCheck={false}
              className="w-full resize-y font-mono text-xs border rounded-md p-3 bg-muted/40 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
            />
            <Button
              onClick={handleCompile}
              disabled={!canCompile || compileState.status === "compiling"}
              className="w-full"
              variant={compileState.status === "ok" ? "outline" : "default"}
            >
              {compileState.status === "compiling" ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Compiling…</>
              ) : (
                <><Code2 className="w-4 h-4 mr-2" /> Compile WAT → WASM</>
              )}
            </Button>

            {compileState.status === "ok" && (
              <div className="flex items-center gap-2 text-sm text-green-700 bg-green-50 border border-green-200 rounded-md px-3 py-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>Compiled — {compileState.byteLength} bytes WASM</span>
              </div>
            )}
            {compileState.status === "error" && (
              <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <pre className="whitespace-pre-wrap break-all font-mono text-xs">{compileState.message}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ABI + deploy */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">ABI (optional)</CardTitle>
              <CardDescription>Describe your contract's functions for the call UI.</CardDescription>
            </CardHeader>
            <CardContent>
              <textarea
                value={abiJson}
                onChange={(e) => setAbiJson(e.target.value)}
                placeholder={JSON.stringify(
                  {
                    functions: [
                      { name: "get", methodId: 0, inputs: [], outputs: ["i32"] },
                      { name: "increment", methodId: 1, inputs: [], outputs: ["i32"] },
                    ],
                  },
                  null,
                  2,
                )}
                rows={10}
                spellCheck={false}
                className="w-full resize-y font-mono text-xs border rounded-md p-3 bg-muted/40 focus:bg-background focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground/50"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Deploy</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                  Deployer address
                </label>
                <Input
                  placeholder="40-character hex address…"
                  value={deployer}
                  onChange={(e) => setDeployer(e.target.value.trim().toLowerCase())}
                  className="font-mono text-xs"
                  maxLength={40}
                />
                {wallet && wallet.address !== deployer && (
                  <button
                    onClick={() => setDeployer(wallet.address)}
                    className="text-xs text-primary mt-1 hover:underline"
                  >
                    Use wallet address ({truncateHash(wallet.address)})
                  </button>
                )}
              </div>

              <Button
                onClick={handleDeploy}
                disabled={!canDeploy || deployState.status === "deploying"}
                className="w-full"
              >
                {deployState.status === "deploying" ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deploying…</>
                ) : (
                  <><Zap className="w-4 h-4 mr-2" /> Deploy Contract</>
                )}
              </Button>

              {!canDeploy && compileState.status !== "ok" && (
                <p className="text-xs text-muted-foreground text-center">
                  Compile first, then deploy.
                </p>
              )}
              {compileState.status === "ok" && !(/^[0-9a-f]{40}$/.test(deployer)) && (
                <p className="text-xs text-destructive text-center">
                  Enter a valid 40-char hex address.
                </p>
              )}

              {deployState.status === "ok" && (
                <div className="border border-green-200 bg-green-50 rounded-md p-3 space-y-2">
                  <div className="flex items-center gap-2 text-green-700 font-medium text-sm">
                    <CheckCircle2 className="w-4 h-4" /> Deployed!
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono bg-white border border-green-200 rounded px-2 py-1 flex-1 truncate">
                      {deployState.address}
                    </code>
                    <CopyButton text={deployState.address} />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full border-green-200 text-green-700 hover:bg-green-100"
                    onClick={() => setLocation(`/contracts/${deployState.address}`)}
                  >
                    View Contract <ChevronRight className="w-3 h-3 ml-1" />
                  </Button>
                </div>
              )}
              {deployState.status === "error" && (
                <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{deployState.message}</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ── Contracts List Tab ────────────────────────────────────────────────────────

function ContractsListTab() {
  const { wallet } = useWallet();
  const [contracts, setContracts] = useState<DeployedContract[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null = show all; wallet.address = show mine only
  const [deployerFilter, setDeployerFilter] = useState<string | null>(null);

  const load = useCallback((deployer: string | null) => {
    setLoading(true);
    setError(null);
    const url = deployer
      ? `/api/contracts?deployer=${encodeURIComponent(deployer)}`
      : "/api/contracts";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        setContracts(d.contracts ?? []);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load contracts");
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(deployerFilter); }, [load, deployerFilter]);

  const handleToggleMine = () => {
    if (!wallet) return;
    const next = deployerFilter ? null : wallet.address;
    setDeployerFilter(next);
  };

  const toolbar = (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2">
        {!loading && (
          <p className="text-sm text-muted-foreground">
            {contracts.length} contract{contracts.length !== 1 ? "s" : ""}
            {deployerFilter && " by you"}
          </p>
        )}
        {wallet && (
          <Button
            variant={deployerFilter ? "default" : "outline"}
            size="sm"
            onClick={handleToggleMine}
            className="h-7 text-xs px-2.5"
          >
            My Contracts
          </Button>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={() => load(deployerFilter)}>
        Refresh
      </Button>
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Address</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Deployer</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Block</th>
                <th className="text-right px-4 py-3 font-medium text-muted-foreground">Calls</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...Array(5)].map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-3"><div className="h-4 w-28 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} /></td>
                  <td className="px-4 py-3 hidden md:table-cell"><div className="h-4 w-24 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} /></td>
                  <td className="px-4 py-3 hidden lg:table-cell"><div className="h-4 w-10 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} /></td>
                  <td className="px-4 py-3 text-right"><div className="h-5 w-8 bg-muted rounded animate-pulse ml-auto" style={{ animationDelay: `${i * 50}ms` }} /></td>
                  <td className="px-4 py-3"><div className="h-7 w-16 bg-muted rounded animate-pulse ml-auto" style={{ animationDelay: `${i * 50}ms` }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="flex items-center gap-2 text-destructive py-8">
          <AlertCircle className="w-4 h-4" /> {error}
          <button onClick={() => load(deployerFilter)} className="ml-2 text-sm text-primary hover:underline">Retry</button>
        </div>
      </div>
    );
  }

  if (contracts.length === 0) {
    return (
      <div className="space-y-3">
        {toolbar}
        <div className="py-16 text-center border border-dashed rounded-lg text-muted-foreground space-y-2">
          <Code2 className="w-8 h-8 mx-auto opacity-40" />
          {deployerFilter ? (
            <>
              <p className="font-medium">No contracts from your address.</p>
              <button onClick={() => setDeployerFilter(null)} className="text-sm text-primary hover:underline">Show all contracts</button>
            </>
          ) : (
            <>
              <p className="font-medium">No contracts deployed yet.</p>
              <p className="text-sm">Use the Deploy tab to deploy your first contract.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {toolbar}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground">Address</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Deployer</th>
              <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Block</th>
              <th className="text-right px-4 py-3 font-medium text-muted-foreground">Calls</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {contracts.map((c) => (
              <tr key={c.address} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">
                  <div className="flex items-center gap-2">
                    <span>{truncateHash(c.address)}</span>
                    <CopyButton text={c.address} />
                  </div>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground hidden md:table-cell">
                  <div className="flex items-center gap-1.5">
                    <Link href={`/address/${c.deployer}`} className="hover:text-primary">
                      {truncateHash(c.deployer)}
                    </Link>
                    {wallet && c.deployer === wallet.address && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">you</Badge>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{c.deployedAt}</td>
                <td className="px-4 py-3 text-right">
                  <Badge variant="secondary">{c.callCount}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/contracts/${c.address}`}>
                    <Button variant="ghost" size="sm">
                      Open <ChevronRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ContractsPage() {
  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center gap-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Code2 className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Smart Contracts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Deploy WASM contracts from WAT source · Call on-chain methods
          </p>
        </div>
      </div>

      <Tabs defaultValue="deploy">
        <TabsList>
          <TabsTrigger value="deploy">Deploy</TabsTrigger>
          <TabsTrigger value="contracts">Deployed Contracts</TabsTrigger>
        </TabsList>

        <TabsContent value="deploy" className="mt-6">
          <DeployTab />
        </TabsContent>

        <TabsContent value="contracts" className="mt-6">
          <ContractsListTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
