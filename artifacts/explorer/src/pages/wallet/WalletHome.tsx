import React from "react";
import { Link, useLocation } from "wouter";
import { useWallet } from "@/wallet/context";
import { useGetAddress, getGetAddressQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/CopyButton";
import { truncateHash, formatAmount, timeAgo } from "@/lib/format";
import { AlertTriangle, Plus, Download, Send, Trash2, ArrowRight, ArrowLeft, KeyRound, BookOpen, ShieldCheck, Info } from "lucide-react";
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
      queryKey: getGetAddressQueryKey(wallet?.address || ""),
      enabled: !!wallet,
      refetchInterval: 10000,
    }
  });

  if (!wallet) {
    return (
      <div className="max-w-2xl mx-auto mt-10 flex flex-col items-center justify-center space-y-8">
        <div className="text-center space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">Equilibrium Wallet</h1>
          <p className="text-muted-foreground">Self-custody, browser-side Ed25519 wallet. Keys never leave your browser.</p>
        </div>

        {/* First-time-user primer */}
        <div className="w-full space-y-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground px-1">How it works</p>

          <div className="grid grid-cols-1 gap-3">
            <div className="flex gap-4 p-4 rounded-lg border bg-card">
              <div className="mt-0.5 shrink-0 p-2 bg-primary/10 rounded-md">
                <KeyRound className="w-4 h-4 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">Your address is a public key</p>
                <p className="text-sm text-muted-foreground">
                  Equilibrium uses <span className="font-medium text-foreground">Ed25519</span> cryptography. When you create a wallet, two mathematically linked values are generated: a <span className="font-medium text-foreground">public key</span> (your address — safe to share) and a <span className="font-medium text-foreground">private key</span> (your signing secret — never share this). Anyone can send EQU to your address; only the private key can authorise spending it.
                </p>
              </div>
            </div>

            <div className="flex gap-4 p-4 rounded-lg border bg-card">
              <div className="mt-0.5 shrink-0 p-2 bg-primary/10 rounded-md">
                <BookOpen className="w-4 h-4 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">Your recovery phrase is your backup</p>
                <p className="text-sm text-muted-foreground">
                  The wallet can generate a <span className="font-medium text-foreground">12-word mnemonic phrase</span> (e.g. <span className="font-mono text-xs bg-muted px-1 py-0.5 rounded">valley river oak…</span>). These words encode your private key in a human-readable form you can write down. If you lose access to this browser, those 12 words are the only way to recover your funds — guard them like cash.
                </p>
              </div>
            </div>

            <div className="flex gap-4 p-4 rounded-lg border bg-card">
              <div className="mt-0.5 shrink-0 p-2 bg-primary/10 rounded-md">
                <ShieldCheck className="w-4 h-4 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold">Everything stays in your browser</p>
                <p className="text-sm text-muted-foreground">
                  Keys are generated and stored locally using the <span className="font-medium text-foreground">Web Crypto API</span> — they are never sent to any server. Signing a transaction happens in your browser; only the signed bytes travel to the network. Clearing your browser data removes the wallet, so back up your phrase first.
                </p>
              </div>
            </div>
          </div>

          <div className="flex gap-2 items-start p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">
              <span className="font-semibold">Before you start:</span> write your recovery phrase on paper the moment it appears and store it somewhere safe. There is no "forgot my key" reset — if the phrase is lost, so are the funds.
            </p>
          </div>
        </div>

        {/* Action cards — rendered as buttons for full keyboard + screen-reader support */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
          <button
            type="button"
            onClick={() => setLocation("/wallet/create")}
            className="text-left rounded-lg border bg-card hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            <div className="pt-6 pb-6 px-6 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="p-3 bg-primary/10 rounded-full">
                <Plus className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Create New Wallet</h3>
                <p className="text-sm text-muted-foreground mt-1">Generate a new keypair locally</p>
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setLocation("/wallet/import")}
            className="text-left rounded-lg border bg-card hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            <div className="pt-6 pb-6 px-6 flex flex-col items-center justify-center space-y-4 text-center">
              <div className="p-3 bg-primary/10 rounded-full">
                <Download className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold">Import Wallet</h3>
                <p className="text-sm text-muted-foreground mt-1">Restore from phrase or private key</p>
              </div>
            </div>
          </button>
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
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center justify-between p-4 border rounded-lg animate-pulse" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="flex items-center gap-4">
                    <div className="w-8 h-8 bg-muted rounded-full" />
                    <div className="space-y-1.5">
                      <div className="h-4 w-28 bg-muted rounded" />
                      <div className="h-3 w-20 bg-muted rounded" />
                    </div>
                  </div>
                  <div className="space-y-1.5 text-right">
                    <div className="h-4 w-16 bg-muted rounded ml-auto" />
                    <div className="h-3 w-10 bg-muted rounded ml-auto" />
                  </div>
                </div>
              ))}
            </div>
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
