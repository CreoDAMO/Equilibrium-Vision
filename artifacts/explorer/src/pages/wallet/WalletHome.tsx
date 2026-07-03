import React from "react";
import { Link, useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { useGetAddress } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { truncateHash, formatAmount, timeAgo } from "@/lib/format";
import { AlertTriangle, Plus, Download, Send, Trash2, ArrowRight, ArrowLeft } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";

export default function WalletHome() {
  const { wallet, clearWallet } = useWallet();
  const [, setLocation] = useLocation();
  
  const { data: addressInfo, isLoading } = useGetAddress(wallet?.address || "", {
    query: {
      enabled: !!wallet,
      refetchInterval: 10000,
    }
  });

  if (!wallet) {
    return (
      <div className="max-w-2xl mx-auto mt-12 flex flex-col items-center justify-center space-y-8">
        <div className="text-center space-y-4">
          <h1 className="text-3xl font-bold tracking-tight">Equilibrium Wallet</h1>
          <p className="text-muted-foreground">Self-custody, browser-side Ed25519 wallet. Keys never leave your browser.</p>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
          <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => setLocation("/wallet/create")}>
            <CardContent className="pt-6 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="p-3 bg-primary/10 rounded-full">
                <Plus className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Create New Wallet</h3>
                <p className="text-sm text-muted-foreground mt-1">Generate a new keypair locally</p>
              </div>
            </CardContent>
          </Card>
          
          <Card className="hover:border-primary/50 transition-colors cursor-pointer" onClick={() => setLocation("/wallet/import")}>
            <CardContent className="pt-6 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="p-3 bg-primary/10 rounded-full">
                <Download className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Import Wallet</h3>
                <p className="text-sm text-muted-foreground mt-1">Import an existing private key</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Wallet</h1>
        <div className="flex gap-2">
          <Button onClick={() => setLocation("/wallet/send")}>
            <Send className="w-4 h-4 mr-2" />
            Send
          </Button>
          
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon">
                <Trash2 className="w-4 h-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear Wallet</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the wallet from your browser. Make sure you have backed up your private key, or you will lose access to your funds forever.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => {
                  clearWallet();
                  setLocation("/wallet");
                }} className="bg-destructive text-destructive-foreground">
                  Yes, clear wallet
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">Your Address</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg">
            <span className="font-mono text-sm break-all">{wallet.address}</span>
            <CopyButton text={wallet.address} />
          </div>
        </CardContent>
      </Card>
      
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Balance</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-8 bg-muted animate-pulse rounded w-1/2" />
            ) : (
              <div className="text-3xl font-bold">{formatAmount(addressInfo?.balance || 0)} <span className="text-lg text-muted-foreground font-normal">EQU</span></div>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Nonce</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="h-8 bg-muted animate-pulse rounded w-1/4" />
            ) : (
              <div className="text-3xl font-bold">{addressInfo?.nonce || 0}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {!addressInfo ? (
            <div className="py-8 text-center text-muted-foreground">Loading...</div>
          ) : addressInfo.transactions.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground border border-dashed rounded-lg">
              No transactions yet.
            </div>
          ) : (
            <div className="space-y-4">
              {addressInfo.transactions.slice(0, 5).map(tx => {
                const isOut = tx.from === wallet.address;
                return (
                  <div key={tx.hash} className="flex items-center justify-between p-4 border rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className={`p-2 rounded-full ${isOut ? 'bg-orange-500/10 text-orange-500' : 'bg-green-500/10 text-green-500'}`}>
                        {isOut ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <Link href={`/tx/${tx.hash}`} className="font-mono text-sm text-primary hover:underline">
                            {truncateHash(tx.hash)}
                          </Link>
                          <Badge variant={tx.status === 'confirmed' ? 'default' : tx.status === 'failed' ? 'destructive' : 'secondary'} className="text-[10px] h-5 px-1.5">
                            {tx.status}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {timeAgo(tx.timestamp)} • {isOut ? `To: ${truncateHash(tx.to)}` : `From: ${truncateHash(tx.from)}`}
                        </div>
                      </div>
                    </div>
                    <div className={`font-mono font-medium ${isOut ? '' : 'text-green-500'}`}>
                      {isOut ? '-' : '+'}{formatAmount(tx.amount)} EQU
                    </div>
                  </div>
                );
              })}
              {addressInfo.transactions.length > 5 && (
                <div className="text-center pt-2">
                  <Link href={`/address/${wallet.address}`} className="text-sm text-primary hover:underline">
                    View all transactions
                  </Link>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
