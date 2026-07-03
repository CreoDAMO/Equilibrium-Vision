import React, { useState } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { importFromPrivKey } from "@/wallet/crypto";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, Plus, Trash2, Shield, Users, CheckCircle2, AlertCircle } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";

export default function WalletMultisig() {
  const { createMultisig } = useWallet();
  const [, setLocation] = useLocation();

  const [pubKeys, setPubKeys] = useState<string[]>(["", ""]);
  const [threshold, setThreshold] = useState(2);
  const [ownPrivKey, setOwnPrivKey] = useState("");
  const [ownPrivKeyError, setOwnPrivKeyError] = useState("");
  const [ownPubKey, setOwnPubKey] = useState("");
  const [pubKeyErrors, setPubKeyErrors] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<{ address: string } | null>(null);

  const addPubKey = () => {
    if (pubKeys.length >= 9) return;
    setPubKeys(p => [...p, ""]);
  };

  const removePubKey = (i: number) => {
    if (pubKeys.length <= 2) return;
    setPubKeys(p => p.filter((_, idx) => idx !== i));
    setPubKeyErrors(prev => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    if (threshold > pubKeys.length - 1) {
      setThreshold(pubKeys.length - 1);
    }
  };

  const updatePubKey = (i: number, val: string) => {
    setPubKeys(p => p.map((v, idx) => idx === i ? val : v));
    setPubKeyErrors(prev => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
  };

  const handlePrivKeyBlur = async () => {
    setOwnPrivKeyError("");
    setOwnPubKey("");
    const cleaned = ownPrivKey.trim();
    if (!cleaned) return;
    if (cleaned.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
      setOwnPrivKeyError("Must be 64 hex characters.");
      return;
    }
    try {
      const { publicKey } = await importFromPrivKey(cleaned);
      setOwnPubKey(publicKey);
    } catch {
      setOwnPrivKeyError("Invalid private key");
    }
  };

  const validate = (): string[] => {
    const errors: Record<number, string> = {};
    const validKeys: string[] = [];

    for (let i = 0; i < pubKeys.length; i++) {
      const k = pubKeys[i]?.trim() ?? "";
      if (!k) { errors[i] = "Required"; continue; }
      if (k.length !== 64 || !/^[0-9a-fA-F]+$/.test(k)) {
        errors[i] = "Must be 64 hex characters";
        continue;
      }
      if (validKeys.includes(k)) { errors[i] = "Duplicate key"; continue; }
      validKeys.push(k);
    }

    setPubKeyErrors(errors);
    return validKeys;
  };

  const handleCreate = async () => {
    setError("");
    const validKeys = validate();
    if (validKeys.length !== pubKeys.length) {
      setError("Fix the errors above before creating.");
      return;
    }
    if (threshold < 1 || threshold > validKeys.length) {
      setError(`Threshold must be between 1 and ${validKeys.length}.`);
      return;
    }

    setCreating(true);
    try {
      const wallet = await createMultisig(validKeys, threshold, ownPrivKey.trim() || undefined);
      setPreview({ address: wallet.address });
    } catch (e: any) {
      setError(e.message ?? "Failed to create multisig wallet");
    } finally {
      setCreating(false);
    }
  };

  if (preview) {
    return (
      <div className="max-w-lg mx-auto mt-10 space-y-4">
        <Card className="border-green-500/50">
          <CardHeader>
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle2 className="w-5 h-5" />
              <CardTitle>Multisig Wallet Created</CardTitle>
            </div>
            <CardDescription>
              {threshold}-of-{pubKeys.length} Ed25519 multisig wallet. All co-signers must share this address.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label className="text-muted-foreground text-xs uppercase tracking-wider">Multisig Address</Label>
              <div className="flex items-center justify-between p-3 bg-muted rounded-md border">
                <span className="font-mono text-sm break-all flex-1 mr-2">{preview.address}</span>
                <CopyButton text={preview.address} />
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Badge variant="secondary">
                <Shield className="w-3 h-3 mr-1" />
                {threshold}-of-{pubKeys.length} threshold
              </Badge>
              <Badge variant="outline">Ed25519</Badge>
              <Badge variant="outline">m-of-n</Badge>
            </div>
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="text-sm">
                Share this address and the signer list with all co-signers. To send a transaction, collect {threshold} signatures and broadcast together.
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={() => setLocation("/wallet")}>
              Go to Wallet
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/wallet")}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create Multi-Sig Wallet</h1>
          <p className="text-muted-foreground text-sm mt-0.5">m-of-n Ed25519 multisignature scheme</p>
        </div>
      </div>

      {/* Co-signers */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Co-Signer Public Keys</CardTitle>
          </div>
          <CardDescription>Add the Ed25519 public key (64 hex chars) of each co-signer.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {pubKeys.map((k, i) => (
            <div key={i} className="space-y-1">
              <Label className="text-xs">Signer {i + 1}</Label>
              <div className="flex gap-2">
                <Input
                  value={k}
                  onChange={e => updatePubKey(i, e.target.value)}
                  placeholder="64-char hex public key"
                  className={`font-mono text-xs ${pubKeyErrors[i] ? "border-destructive" : ""}`}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {pubKeys.length > 2 && (
                  <Button variant="ghost" size="icon" onClick={() => removePubKey(i)}>
                    <Trash2 className="w-4 h-4 text-muted-foreground" />
                  </Button>
                )}
              </div>
              {pubKeyErrors[i] && <p className="text-xs text-destructive">{pubKeyErrors[i]}</p>}
            </div>
          ))}
          {pubKeys.length < 9 && (
            <Button variant="outline" size="sm" onClick={addPubKey}>
              <Plus className="w-3 h-3 mr-1" /> Add Signer
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Threshold */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base">Signature Threshold</CardTitle>
          </div>
          <CardDescription>How many signatures are required to authorize a transaction.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="icon"
                onClick={() => setThreshold(t => Math.max(1, t - 1))}
                disabled={threshold <= 1}
              >−</Button>
              <span className="w-10 text-center font-mono text-lg font-semibold">{threshold}</span>
              <Button
                variant="outline" size="icon"
                onClick={() => setThreshold(t => Math.min(pubKeys.length, t + 1))}
                disabled={threshold >= pubKeys.length}
              >+</Button>
            </div>
            <div className="text-sm text-muted-foreground">
              of {pubKeys.length} signers required
              {" "}
              <Badge variant="secondary" className="ml-1">{threshold}-of-{pubKeys.length}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Own private key (optional) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Signing Key (Optional)</CardTitle>
          <CardDescription>
            If you are one of the co-signers, enter your private key. It stays in your browser and lets you sign transactions directly from this wallet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label>Your Private Key</Label>
          <Input
            type="password"
            placeholder="64-char hex private key (optional)"
            value={ownPrivKey}
            onChange={e => { setOwnPrivKey(e.target.value); setOwnPrivKeyError(""); setOwnPubKey(""); }}
            onBlur={handlePrivKeyBlur}
            className="font-mono"
          />
          {ownPrivKeyError && <p className="text-xs text-destructive">{ownPrivKeyError}</p>}
          {ownPubKey && (
            <div className="text-xs text-muted-foreground">
              Public key: <span className="font-mono">{ownPubKey.slice(0, 16)}…</span>
              {pubKeys.some(k => k.trim() === ownPubKey)
                ? <Badge variant="outline" className="ml-2 text-green-600">Matched signer ✓</Badge>
                : <Badge variant="destructive" className="ml-2">Not in signer list</Badge>
              }
            </div>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button onClick={handleCreate} disabled={creating} size="lg">
          <Shield className="w-4 h-4 mr-2" />
          {creating ? "Creating..." : `Create ${threshold}-of-${pubKeys.length} Multisig`}
        </Button>
      </div>
    </div>
  );
}
