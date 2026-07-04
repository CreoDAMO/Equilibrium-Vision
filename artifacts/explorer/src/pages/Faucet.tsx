import React, { useState } from "react";
import {
  useGetFaucetStatus,
  useRequestFaucet,
  getGetFaucetStatusQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Droplets, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { formatAmount } from "@/lib/format";

// ── Cooldown timer ────────────────────────────────────────────────────────────

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "Ready";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Status panel ──────────────────────────────────────────────────────────────

const HEX_40 = /^[0-9a-fA-F]{40}$/;

function StatusPanel({ address }: { address: string }) {
  const isValid = HEX_40.test(address);
  const { data, isLoading, isError } = useGetFaucetStatus(address, {
    query: {
      queryKey: getGetFaucetStatusQueryKey(address),
      refetchInterval: 5000,
      enabled: isValid,
    },
  });

  if (!isValid) return null;
  if (isLoading) return <p className="text-sm text-muted-foreground">Checking cooldown…</p>;
  if (isError) return <p className="text-sm text-destructive">Could not fetch cooldown status.</p>;
  if (!data) return null;

  return (
    <div className="flex items-center gap-3 mt-3">
      {data.canDrip ? (
        <Badge variant="outline" className="border-green-200 text-green-700 bg-green-50">
          <CheckCircle2 className="w-3 h-3 mr-1" /> Ready to drip
        </Badge>
      ) : (
        <Badge variant="outline" className="border-orange-200 text-orange-700 bg-orange-50">
          <Clock className="w-3 h-3 mr-1" /> Cooldown: {formatCountdown(data.cooldownRemaining)}
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">
        Drip amount: {formatAmount(data.dripAmount)} EQU
      </span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Faucet() {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<{ ok: true; balance: number; amount: number } | { ok: false; message: string } | null>(null);

  const queryClient = useQueryClient();
  const { mutate: requestDrip, isPending } = useRequestFaucet({
    mutation: {
      onSuccess: (data) => {
        setResult({ ok: true, balance: data.balance, amount: data.amount });
        // Invalidate by the address the server dripped to (not outer state, which may have changed).
        queryClient.invalidateQueries({ queryKey: getGetFaucetStatusQueryKey(data.address) });
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error
            ? err.message
            : "Request failed — check address or cooldown";
        setResult({ ok: false, message: msg });
      },
    },
  });

  const handleDrip = () => {
    if (address.length !== 40) return;
    setResult(null);
    requestDrip({ data: { address } });
  };

  const isValidAddr = HEX_40.test(address);

  return (
    <div className="space-y-6 max-w-xl">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="bg-primary/10 text-primary p-3 rounded-xl">
          <Droplets className="w-8 h-8" />
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Testnet Faucet</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Request 1,000 EQU — one drip per address per hour
          </p>
        </div>
      </div>

      {/* Request form */}
      <Card>
        <CardHeader>
          <CardTitle>Request Tokens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="faucet-addr">
              Equilibrium Address
            </label>
            <Input
              id="faucet-addr"
              placeholder="40-character hex address…"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value.trim().toLowerCase());
                setResult(null);
              }}
              maxLength={40}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {address.length}/40 characters
              {address.length > 0 && !isValidAddr && (
                <span className="text-destructive ml-2">— must be 40 hex chars</span>
              )}
            </p>
          </div>

          <StatusPanel address={address} />

          <Button
            onClick={handleDrip}
            disabled={!isValidAddr || isPending}
            className="w-full"
          >
            <Droplets className="w-4 h-4 mr-2" />
            {isPending ? "Sending…" : "Request 1,000 EQU"}
          </Button>

          {/* Result banner */}
          {result && (
            <div
              className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${
                result.ok
                  ? "border-green-200 bg-green-50 text-green-800"
                  : "border-destructive/30 bg-destructive/10 text-destructive"
              }`}
            >
              {result.ok ? (
                <>
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Drip successful!</p>
                    <p className="text-xs mt-0.5">
                      +{formatAmount(result.amount)} EQU sent · New balance:{" "}
                      {formatAmount(result.balance)} EQU
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">Drip failed</p>
                    <p className="text-xs mt-0.5">{result.message}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Info card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Faucet Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Drip amount</dt>
            <dd className="font-medium">1,000 EQU</dd>
            <dt className="text-muted-foreground">Cooldown period</dt>
            <dd className="font-medium">1 hour per address</dd>
            <dt className="text-muted-foreground">Network</dt>
            <dd className="font-medium">Equilibrium Testnet</dd>
            <dt className="text-muted-foreground">Token</dt>
            <dd className="font-medium">EQU (native)</dd>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
