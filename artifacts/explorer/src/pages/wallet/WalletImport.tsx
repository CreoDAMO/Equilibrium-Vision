import React, { useState } from "react";
import { useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { importFromPrivKey } from "@/wallet/crypto";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function WalletImport() {
  const { importWallet } = useWallet();
  const [, setLocation] = useLocation();
  const [privKey, setPrivKey] = useState("");
  const [error, setError] = useState("");
  const [previewAddress, setPreviewAddress] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const handlePreview = async () => {
    try {
      setError("");
      setPreviewAddress("");
      const cleanKey = privKey.trim();
      if (!cleanKey) return;
      if (cleanKey.length !== 64) {
        setError("Private key must be exactly 64 hex characters.");
        return;
      }
      if (!/^[0-9a-fA-F]+$/.test(cleanKey)) {
        setError("Private key must contain only hex characters (0-9, a-f).");
        return;
      }
      
      const w = await importFromPrivKey(cleanKey);
      setPreviewAddress(w.address);
    } catch (e: any) {
      setError(e.message || "Invalid private key.");
    }
  };

  const handleImport = async () => {
    if (!previewAddress) return;
    setIsImporting(true);
    try {
      await importWallet(privKey.trim());
      setLocation("/wallet");
    } catch (e: any) {
      setError(e.message || "Failed to import wallet");
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-12">
      <Card>
        <CardHeader>
          <CardTitle>Import Wallet</CardTitle>
          <CardDescription>Enter your 64-character hex private key to restore your wallet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="privKey">Private Key (Hex)</Label>
            <Input
              id="privKey"
              type="password"
              placeholder="e.g. a1b2c3d4..."
              value={privKey}
              onChange={(e) => {
                setPrivKey(e.target.value);
                setPreviewAddress("");
                setError("");
              }}
              onBlur={handlePreview}
            />
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {previewAddress && (
            <div className="p-4 bg-muted rounded-md border space-y-1">
              <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Derived Address</div>
              <div className="font-mono text-sm break-all">{previewAddress}</div>
            </div>
          )}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button variant="outline" onClick={() => setLocation("/wallet")}>Cancel</Button>
          <Button onClick={handleImport} disabled={!previewAddress || !!error || isImporting}>
            {isImporting ? "Importing..." : "Import Wallet"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
