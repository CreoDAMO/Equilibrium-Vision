import React, { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { useGetAddress, getGetAddressQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatAmount } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Send } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function WalletSend() {
  const { wallet, signAndBroadcast } = useWallet();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  
  const { data: addressInfo } = useGetAddress(wallet?.address || "", {
    query: { queryKey: getGetAddressQueryKey(wallet?.address || ""), enabled: !!wallet }
  });

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("1");
  const [isSending, setIsSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Redirect if no wallet
  useEffect(() => {
    if (wallet === null) {
      setLocation("/wallet");
    }
  }, [wallet, setLocation]);

  if (!wallet) return null;

  const nextNonce = addressInfo ? addressInfo.nonce + 1 : 1;
  const balance = addressInfo?.balance || 0;

  const numAmount = parseInt(amount, 10);
  const numFee = parseInt(fee, 10);
  
  const isValid = 
    to.length === 40 && 
    /^[0-9a-fA-F]+$/.test(to) &&
    !isNaN(numAmount) && numAmount > 0 &&
    !isNaN(numFee) && numFee >= 0 &&
    (numAmount + numFee) <= balance;

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;

    setIsSending(true);
    try {
      const res = await signAndBroadcast(to.toLowerCase(), numAmount, numFee, nextNonce);
      setTxHash(res.txHash);
      toast({
        title: "Transaction Broadcasted",
        description: "Your transaction has been submitted to the mempool.",
      });
    } catch (err: any) {
      toast({
        title: "Broadcast Failed",
        description: err.message || "Could not broadcast transaction",
        variant: "destructive"
      });
    } finally {
      setIsSending(false);
    }
  };

  if (txHash) {
    return (
      <div className="max-w-md mx-auto mt-12">
        <Card>
          <CardHeader className="text-center pt-8 pb-4">
            <div className="w-16 h-16 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <Send className="w-8 h-8" />
            </div>
            <CardTitle className="text-2xl">Transaction Sent</CardTitle>
            <CardDescription>Your transaction is on its way.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pb-8">
            <div className="p-4 bg-muted/50 rounded-lg border text-center space-y-2">
              <div className="text-sm font-medium text-muted-foreground">Transaction Hash</div>
              <Link href={`/tx/${txHash}`} className="font-mono text-sm text-primary hover:underline break-all block">
                {txHash}
              </Link>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={() => setLocation("/wallet")}>
              Back to Wallet
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto">
      <Button variant="ghost" className="mb-6" onClick={() => setLocation("/wallet")}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back
      </Button>

      <Card>
        <form onSubmit={handleSend}>
          <CardHeader>
            <CardTitle>Send Equilibrium</CardTitle>
            <CardDescription>Send funds to another address on the network.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            
            <div className="flex justify-between items-center p-4 bg-muted/50 rounded-lg border">
              <div>
                <div className="text-sm text-muted-foreground">Available Balance</div>
                <div className="font-medium">{formatAmount(balance)} EQU</div>
              </div>
              <div className="text-right">
                <div className="text-sm text-muted-foreground">Next Nonce</div>
                <div className="font-medium">{nextNonce}</div>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="to">Recipient Address</Label>
              <Input
                id="to"
                placeholder="40-character hex address"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="font-mono"
              />
              {to.length > 0 && to.length !== 40 && (
                <div className="text-xs text-destructive">Address must be 40 characters</div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount (EQU)</Label>
                <Input
                  id="amount"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fee">Fee (EQU)</Label>
                <Input
                  id="fee"
                  type="number"
                  min="0"
                  step="1"
                  value={fee}
                  onChange={(e) => setFee(e.target.value)}
                />
              </div>
            </div>

            {!isNaN(numAmount) && !isNaN(numFee) && (numAmount + numFee > balance) && (
              <Alert variant="destructive">
                <AlertDescription>Insufficient balance for amount + fee.</AlertDescription>
              </Alert>
            )}

          </CardContent>
          <CardFooter className="bg-muted/30 pt-6">
            <Button type="submit" className="w-full" disabled={!isValid || isSending}>
              {isSending ? "Sending..." : "Sign & Broadcast"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
