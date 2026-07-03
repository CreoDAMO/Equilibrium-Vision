import React, { createContext, useContext, useState, useEffect } from "react";
import { generateWallet, importFromPrivKey, signTx } from "./crypto";
import { useBroadcastTransaction } from "@workspace/api-client-react";

type WalletState = {
  privateKey: string;
  publicKey: string;
  address: string;
} | null;

interface WalletContextValue {
  wallet: WalletState;
  createWallet: () => Promise<WalletState>;
  importWallet: (privHex: string) => Promise<WalletState>;
  clearWallet: () => void;
  signAndBroadcast: (to: string, amount: number, fee: number, nonce: number) => Promise<any>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<WalletState>(null);
  const broadcastTx = useBroadcastTransaction();

  useEffect(() => {
    const stored = localStorage.getItem("equ_wallet");
    if (stored) {
      try {
        setWallet(JSON.parse(stored));
      } catch (e) {
        console.error("Failed to parse wallet from localStorage", e);
      }
    }
  }, []);

  const saveWallet = (w: NonNullable<WalletState>) => {
    localStorage.setItem("equ_wallet", JSON.stringify(w));
    setWallet(w);
  };

  const createWallet = async () => {
    const w = await generateWallet();
    saveWallet(w);
    return w;
  };

  const importWallet = async (privHex: string) => {
    const w = await importFromPrivKey(privHex);
    saveWallet(w);
    return w;
  };

  const clearWallet = () => {
    localStorage.removeItem("equ_wallet");
    setWallet(null);
  };

  const signAndBroadcast = async (to: string, amount: number, fee: number, nonce: number) => {
    if (!wallet) throw new Error("No wallet loaded");
    const signature = await signTx(wallet.privateKey, wallet.address, to, amount, fee, nonce);
    const payload = {
      from: wallet.address,
      to,
      amount,
      fee,
      nonce,
      signature,
      publicKey: wallet.publicKey
    };
    
    return broadcastTx.mutateAsync({ data: payload });
  };

  return (
    <WalletContext.Provider value={{ wallet, createWallet, importWallet, clearWallet, signAndBroadcast }}>
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
