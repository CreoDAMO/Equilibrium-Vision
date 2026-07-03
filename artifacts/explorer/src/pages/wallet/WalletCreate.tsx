import React, { useState } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { generateWallet } from "@/wallet/crypto";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { AlertTriangle, KeyRound, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export default function WalletCreate() {
  const { importWallet } = useWallet();
  const [, setLocation] = useLocation();
  const [generated, setGenerated] = useState<{privateKey: string, publicKey: string, address: string} | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const w = await generateWallet();
      setGenerated(w);
    } catch (e) {
      console.error(e);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = async () => {
    if (!generated) return;
    await importWallet(generated.privateKey);
    setLocation("/wallet");
  };

  if (!generated) {
    return (
      <div className="max-w-md mx-auto mt-12">
        <Card>
          <CardHeader>
            <CardTitle>Create New Wallet</CardTitle>
            <CardDescription>Generate a new Ed25519 keypair locally in your browser.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <ShieldAlert className="h-4 w-4" />
              <AlertTitle>Self-Custody</AlertTitle>
              <AlertDescription>
                Your keys are generated locally and never sent to the server. You are responsible for backing up your private key.
              </AlertDescription>
            </Alert>
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" onClick={() => setLocation("/wallet")}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={isGenerating}>
              <KeyRound className="w-4 h-4 mr-2" />
              {isGenerating ? "Generating..." : "Generate Keypair"}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto mt-8">
      <Card className="border-destructive">
        <CardHeader className="bg-destructive/5 pb-4 border-b">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle>Save Your Private Key</CardTitle>
          </div>
          <CardDescription className="text-destructive font-medium mt-2">
            This is the ONLY time you will see your private key. If you lose it, your funds cannot be recovered.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pt-6">
          
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Private Key (Keep Secret!)</label>
            <div className="flex items-center justify-between p-3 bg-muted rounded-md border border-destructive/20">
              <span className="font-mono text-sm break-all text-foreground">{generated.privateKey}</span>
              <CopyButton text={generated.privateKey} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Public Key</label>
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border">
              <span className="font-mono text-sm break-all text-muted-foreground">{generated.publicKey}</span>
              <CopyButton text={generated.publicKey} />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Address</label>
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-md border">
              <span className="font-mono text-sm break-all text-muted-foreground">{generated.address}</span>
              <CopyButton text={generated.address} />
            </div>
          </div>

        </CardContent>
        <CardFooter className="flex justify-between pt-4 border-t">
          <Button variant="outline" onClick={() => setGenerated(null)}>Start Over</Button>
          <Button onClick={handleSave}>
            I have saved my private key
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
