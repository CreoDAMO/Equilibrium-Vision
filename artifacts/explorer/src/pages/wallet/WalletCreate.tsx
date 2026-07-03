import React, { useState } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { generateWallet, generateMnemonic, mnemonicToWallet } from "@/wallet/crypto";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/CopyButton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle, KeyRound, ShieldAlert, BookOpen,
  ChevronLeft, ChevronRight, Lock, Eye, EyeOff, RefreshCw,
} from "lucide-react";

type Step = "choose" | "mnemonic-show" | "mnemonic-confirm" | "password" | "raw-show";
type Mode = "mnemonic" | "raw";

function MnemonicGrid({ words }: { words: string[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {words.map((w, i) => (
        <div key={i} className="flex items-center gap-1.5 p-2 bg-muted rounded-md border text-sm">
          <span className="text-muted-foreground w-5 text-right text-xs font-mono">{i + 1}.</span>
          <span className="font-mono font-medium">{w}</span>
        </div>
      ))}
    </div>
  );
}

function pickThreeIndices(len: number): number[] {
  const s = new Set<number>();
  while (s.size < 3) s.add(Math.floor(Math.random() * len));
  return [...s].sort((a, b) => a - b);
}

export default function WalletCreate() {
  const { importWallet, createFromMnemonic, saveEncryptedKeystore } = useWallet();
  const [, setLocation] = useLocation();

  const [step, setStep] = useState<Step>("choose");
  const [words, setWords] = useState<string[]>([]);
  const [mnemonic, setMnemonic] = useState("");
  const [rawWallet, setRawWallet] = useState<{ privateKey: string; publicKey: string; address: string } | null>(null);

  const [confirmIndices, setConfirmIndices] = useState<number[]>([]);
  const [confirmInputs, setConfirmInputs] = useState<Record<number, string>>({});
  const [confirmError, setConfirmError] = useState("");

  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [skipPassword, setSkipPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleChooseMnemonic = () => {
    const mn = generateMnemonic(128);
    const ws = mn.split(" ");
    setMnemonic(mn);
    setWords(ws);
    setConfirmIndices(pickThreeIndices(ws.length));
    setConfirmInputs({});
    setConfirmError("");
    setStep("mnemonic-show");
  };

  const handleChooseRaw = async () => {
    const w = await generateWallet();
    setRawWallet(w);
    setStep("raw-show");
  };

  const handleMnemonicConfirm = () => {
    setConfirmError("");
    for (const idx of confirmIndices) {
      const entered = (confirmInputs[idx] ?? "").trim().toLowerCase();
      if (entered !== words[idx]) {
        setConfirmError(`Word #${idx + 1} is incorrect. Please check your phrase.`);
        return;
      }
    }
    setStep("password");
  };

  const handleFinish = async () => {
    if (!skipPassword) {
      if (password.length < 8) { setPasswordError("Password must be at least 8 characters."); return; }
      if (password !== passwordConfirm) { setPasswordError("Passwords don't match."); return; }
    }
    setSaving(true);
    try {
      if (!skipPassword) await saveEncryptedKeystore(mnemonic, password);
      await createFromMnemonic(mnemonic);
      setLocation("/wallet");
    } catch (e: any) {
      setPasswordError(e.message ?? "Failed to save wallet");
    } finally {
      setSaving(false);
    }
  };

  // ── Choose ────────────────────────────────────────────────────────────────────
  if (step === "choose") {
    return (
      <div className="max-w-xl mx-auto mt-10 space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Create New Wallet</h1>
          <p className="text-muted-foreground mt-1">Choose how to generate your keys.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card className="cursor-pointer hover:border-primary transition-colors" onClick={handleChooseMnemonic}>
            <CardContent className="pt-6 space-y-3">
              <div className="p-2 bg-primary/10 rounded-full w-fit">
                <BookOpen className="w-5 h-5 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">Seed Phrase</h3>
                  <Badge variant="outline" className="text-xs">Recommended</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  BIP-39 mnemonic + SLIP-0010 Ed25519 HD derivation. Recoverable from 12 words.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card className="cursor-pointer hover:border-muted-foreground/50 transition-colors" onClick={handleChooseRaw}>
            <CardContent className="pt-6 space-y-3">
              <div className="p-2 bg-muted rounded-full w-fit">
                <KeyRound className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h3 className="font-semibold">Raw Keypair</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Generate a single Ed25519 private key. No recovery phrase.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <Button variant="ghost" onClick={() => setLocation("/wallet")}>
          <ChevronLeft className="w-4 h-4 mr-1" /> Back
        </Button>
      </div>
    );
  }

  // ── Raw show ──────────────────────────────────────────────────────────────────
  if (step === "raw-show" && rawWallet) {
    return (
      <div className="max-w-2xl mx-auto mt-8">
        <Card className="border-destructive">
          <CardHeader className="bg-destructive/5 border-b">
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              <CardTitle>Save Your Private Key</CardTitle>
            </div>
            <CardDescription className="text-destructive font-medium mt-1">
              This is the only time you will see your private key. Losing it means losing your funds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            {[
              { label: "Private Key (keep secret!)", value: rawWallet.privateKey, danger: true },
              { label: "Public Key", value: rawWallet.publicKey },
              { label: "Address", value: rawWallet.address },
            ].map(({ label, value, danger }) => (
              <div key={label} className="space-y-1">
                <label className="text-sm font-medium text-muted-foreground">{label}</label>
                <div className={`flex items-center justify-between p-3 bg-muted rounded-md border ${danger ? "border-destructive/30" : ""}`}>
                  <span className="font-mono text-xs break-all flex-1 mr-2">{value}</span>
                  <CopyButton text={value} />
                </div>
              </div>
            ))}
          </CardContent>
          <CardFooter className="flex justify-between border-t pt-4">
            <Button variant="outline" onClick={() => setStep("choose")}>Back</Button>
            <Button onClick={() => importWallet(rawWallet.privateKey).then(() => setLocation("/wallet"))}>
              I've saved my key →
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── Mnemonic show ─────────────────────────────────────────────────────────────
  if (step === "mnemonic-show") {
    return (
      <div className="max-w-2xl mx-auto mt-8 space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep("choose")}><ChevronLeft className="w-4 h-4" /></Button>
          <h2 className="text-xl font-semibold">Your Seed Phrase</h2>
        </div>
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Write these words down offline</AlertTitle>
          <AlertDescription>Anyone with these 12 words can access your funds. Never store them digitally or share them.</AlertDescription>
        </Alert>
        <Card>
          <CardContent className="pt-6">
            <MnemonicGrid words={words} />
          </CardContent>
          <CardFooter className="justify-between border-t pt-4">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleChooseMnemonic}>
                <RefreshCw className="w-3 h-3 mr-1" /> Regenerate
              </Button>
              <CopyButton text={mnemonic} />
            </div>
            <Button onClick={() => setStep("mnemonic-confirm")}>
              I've written it down <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── Mnemonic confirm ──────────────────────────────────────────────────────────
  if (step === "mnemonic-confirm") {
    return (
      <div className="max-w-lg mx-auto mt-8 space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep("mnemonic-show")}><ChevronLeft className="w-4 h-4" /></Button>
          <h2 className="text-xl font-semibold">Verify Your Phrase</h2>
        </div>
        <p className="text-sm text-muted-foreground">Enter the words at these positions to confirm you've saved them.</p>
        <Card>
          <CardContent className="pt-6 space-y-4">
            {confirmIndices.map(idx => (
              <div key={idx} className="space-y-1">
                <Label>Word #{idx + 1}</Label>
                <Input
                  placeholder={`Word #${idx + 1}`}
                  value={confirmInputs[idx] ?? ""}
                  onChange={e => setConfirmInputs(p => ({ ...p, [idx]: e.target.value }))}
                  autoCapitalize="none" autoCorrect="off" spellCheck={false}
                />
              </div>
            ))}
            {confirmError && <p className="text-sm text-destructive">{confirmError}</p>}
          </CardContent>
          <CardFooter className="justify-between border-t pt-4">
            <Button variant="outline" onClick={() => setStep("mnemonic-show")}>Back</Button>
            <Button onClick={handleMnemonicConfirm}>Confirm <ChevronRight className="w-4 h-4 ml-1" /></Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── Password / encrypt ────────────────────────────────────────────────────────
  if (step === "password") {
    return (
      <div className="max-w-lg mx-auto mt-8 space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setStep("mnemonic-confirm")}><ChevronLeft className="w-4 h-4" /></Button>
          <h2 className="text-xl font-semibold">Encrypt Keystore</h2>
        </div>
        <Card>
          <CardHeader>
            <CardDescription>
              Optionally protect your seed phrase with AES-256-GCM encryption (PBKDF2, 100k iterations). Only the ciphertext is stored — your password never leaves the browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!skipPassword && (
              <>
                <div className="space-y-1">
                  <Label>Password</Label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={e => { setPassword(e.target.value); setPasswordError(""); }}
                    />
                    <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowPassword(p => !p)}>
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>Confirm Password</Label>
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="Repeat password"
                    value={passwordConfirm}
                    onChange={e => { setPasswordConfirm(e.target.value); setPasswordError(""); }}
                  />
                </div>
                {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
              </>
            )}
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" checked={skipPassword} onChange={e => setSkipPassword(e.target.checked)} className="rounded" />
              Skip encryption (store seed unencrypted — not recommended)
            </label>
            {skipPassword && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>Your seed phrase will be stored unencrypted in localStorage.</AlertDescription>
              </Alert>
            )}
          </CardContent>
          <CardFooter className="justify-between border-t pt-4">
            <Button variant="outline" onClick={() => setStep("mnemonic-confirm")}>Back</Button>
            <Button onClick={handleFinish} disabled={saving}>
              <Lock className="w-4 h-4 mr-2" />
              {saving ? "Saving..." : skipPassword ? "Create Wallet" : "Encrypt & Create"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return null;
}
