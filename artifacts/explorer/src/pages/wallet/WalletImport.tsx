import React, { useState } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { importFromPrivKey, validateMnemonicPhrase } from "@/wallet/crypto";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Key, BookOpen, Lock, ChevronLeft, Eye, EyeOff } from "lucide-react";

type ImportMode = "choose" | "mnemonic" | "privkey" | "keystore";

export default function WalletImport() {
  const { importWallet, importFromMnemonic, loadEncryptedKeystore, hasEncryptedKeystore } = useWallet();
  const [, setLocation] = useLocation();
  const [mode, setMode] = useState<ImportMode>("choose");

  // Mnemonic state
  const [mnemonic, setMnemonic] = useState("");
  const [mnemonicError, setMnemonicError] = useState("");
  const [mnemonicPreview, setMnemonicPreview] = useState("");

  // Private key state
  const [privKey, setPrivKey] = useState("");
  const [privKeyError, setPrivKeyError] = useState("");
  const [privKeyPreview, setPrivKeyPreview] = useState("");

  // Keystore state
  const [ksPassword, setKsPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [ksError, setKsError] = useState("");

  const [loading, setLoading] = useState(false);

  // ── Mnemonic ──────────────────────────────────────────────────────────────────

  const handleMnemonicPreview = async () => {
    const cleaned = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    setMnemonicError("");
    setMnemonicPreview("");
    if (!cleaned) return;
    if (!validateMnemonicPhrase(cleaned)) {
      setMnemonicError("Invalid mnemonic phrase. Check spelling and word count (12 or 24 words).");
      return;
    }
    try {
      const { importFromPrivKey: _, mnemonicToWallet } = await import("@/wallet/crypto");
      const { address } = await mnemonicToWallet(cleaned);
      setMnemonicPreview(address);
    } catch (e: any) {
      setMnemonicError(e.message ?? "Failed to derive address");
    }
  };

  const handleMnemonicImport = async () => {
    const cleaned = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    setLoading(true);
    try {
      await importFromMnemonic(cleaned);
      setLocation("/wallet");
    } catch (e: any) {
      setMnemonicError(e.message ?? "Failed to import mnemonic");
    } finally {
      setLoading(false);
    }
  };

  // ── Private key ───────────────────────────────────────────────────────────────

  const handlePrivKeyPreview = async () => {
    const cleaned = privKey.trim();
    setPrivKeyError("");
    setPrivKeyPreview("");
    if (!cleaned) return;
    if (cleaned.length !== 64) { setPrivKeyError("Private key must be exactly 64 hex characters."); return; }
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) { setPrivKeyError("Private key must contain only hex characters."); return; }
    try {
      const { address } = await importFromPrivKey(cleaned);
      setPrivKeyPreview(address);
    } catch (e: any) {
      setPrivKeyError(e.message ?? "Invalid private key");
    }
  };

  const handlePrivKeyImport = async () => {
    if (!privKeyPreview) return;
    setLoading(true);
    try {
      await importWallet(privKey.trim());
      setLocation("/wallet");
    } catch (e: any) {
      setPrivKeyError(e.message ?? "Failed to import");
    } finally {
      setLoading(false);
    }
  };

  // ── Encrypted keystore ────────────────────────────────────────────────────────

  const handleKeystoreImport = async () => {
    setKsError("");
    if (!ksPassword) { setKsError("Enter your keystore password."); return; }
    setLoading(true);
    try {
      await loadEncryptedKeystore(ksPassword);
      setLocation("/wallet");
    } catch (e: any) {
      setKsError(e.message ?? "Failed to decrypt keystore");
    } finally {
      setLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  if (mode === "choose") {
    return (
      <div className="max-w-xl mx-auto mt-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Import Wallet</h1>
          <p className="text-muted-foreground mt-1">Choose your import method.</p>
        </div>

        <div className="space-y-3">
          <Card className="cursor-pointer hover:border-primary transition-colors" onClick={() => setMode("mnemonic")}>
            <CardContent className="pt-5 flex items-center gap-4">
              <div className="p-2 bg-primary/10 rounded-full"><BookOpen className="w-5 h-5 text-primary" /></div>
              <div>
                <h3 className="font-semibold">Seed Phrase</h3>
                <p className="text-sm text-muted-foreground">12 or 24 BIP-39 words</p>
              </div>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:border-primary transition-colors" onClick={() => setMode("privkey")}>
            <CardContent className="pt-5 flex items-center gap-4">
              <div className="p-2 bg-muted rounded-full"><Key className="w-5 h-5 text-muted-foreground" /></div>
              <div>
                <h3 className="font-semibold">Private Key</h3>
                <p className="text-sm text-muted-foreground">64-character hex string</p>
              </div>
            </CardContent>
          </Card>

          {hasEncryptedKeystore() && (
            <Card className="cursor-pointer hover:border-primary transition-colors" onClick={() => setMode("keystore")}>
              <CardContent className="pt-5 flex items-center gap-4">
                <div className="p-2 bg-green-500/10 rounded-full"><Lock className="w-5 h-5 text-green-600" /></div>
                <div>
                  <h3 className="font-semibold">Encrypted Keystore</h3>
                  <p className="text-sm text-muted-foreground">AES-GCM keystore found in this browser</p>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <Button variant="ghost" onClick={() => setLocation("/wallet")}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  if (mode === "mnemonic") {
    return (
      <div className="max-w-lg mx-auto mt-8">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode("choose")}><ChevronLeft className="w-4 h-4" /></Button>
              <CardTitle>Import Seed Phrase</CardTitle>
            </div>
            <CardDescription>Enter your 12 or 24 BIP-39 mnemonic words, separated by spaces.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Seed Phrase</Label>
              <Textarea
                placeholder="word1 word2 word3 ..."
                value={mnemonic}
                onChange={e => { setMnemonic(e.target.value); setMnemonicError(""); setMnemonicPreview(""); }}
                onBlur={handleMnemonicPreview}
                rows={3}
                className="font-mono text-sm"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {mnemonicError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{mnemonicError}</AlertDescription>
              </Alert>
            )}
            {mnemonicPreview && (
              <div className="p-3 bg-muted rounded-md border space-y-1">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Derived Address</div>
                <div className="font-mono text-sm break-all">{mnemonicPreview}</div>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={() => setMode("choose")}>Back</Button>
            <Button onClick={handleMnemonicImport} disabled={!mnemonicPreview || loading}>
              {loading ? "Importing..." : "Import Wallet"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (mode === "privkey") {
    return (
      <div className="max-w-md mx-auto mt-8">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode("choose")}><ChevronLeft className="w-4 h-4" /></Button>
              <CardTitle>Import Private Key</CardTitle>
            </div>
            <CardDescription>Enter your 64-character hex Ed25519 private key.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Private Key (Hex)</Label>
              <Input
                type="password"
                placeholder="64 hex characters"
                value={privKey}
                onChange={e => { setPrivKey(e.target.value); setPrivKeyError(""); setPrivKeyPreview(""); }}
                onBlur={handlePrivKeyPreview}
                className="font-mono"
              />
            </div>
            {privKeyError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{privKeyError}</AlertDescription>
              </Alert>
            )}
            {privKeyPreview && (
              <div className="p-3 bg-muted rounded-md border space-y-1">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Derived Address</div>
                <div className="font-mono text-sm break-all">{privKeyPreview}</div>
              </div>
            )}
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={() => setMode("choose")}>Back</Button>
            <Button onClick={handlePrivKeyImport} disabled={!privKeyPreview || loading}>
              {loading ? "Importing..." : "Import Wallet"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (mode === "keystore") {
    return (
      <div className="max-w-md mx-auto mt-8">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setMode("choose")}><ChevronLeft className="w-4 h-4" /></Button>
              <CardTitle>Unlock Encrypted Keystore</CardTitle>
            </div>
            <CardDescription>Enter the password you used when creating your encrypted keystore.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label>Password</Label>
              <div className="relative">
                <Input
                  type={showPassword ? "text" : "password"}
                  placeholder="Keystore password"
                  value={ksPassword}
                  onChange={e => { setKsPassword(e.target.value); setKsError(""); }}
                />
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowPassword(p => !p)}>
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            {ksError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{ksError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={() => setMode("choose")}>Back</Button>
            <Button onClick={handleKeystoreImport} disabled={loading}>
              <Lock className="w-4 h-4 mr-2" />
              {loading ? "Decrypting..." : "Unlock Wallet"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return null;
}
