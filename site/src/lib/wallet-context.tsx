import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  generateKeypair,
  generatePhrase,
  keypairFromSeed,
  signTx,
  walletFromMnemonic,
  type Keypair,
} from "@/protocol/wallet";
import { hexToBytes } from "@/protocol/bytes";
import { useNetwork } from "./network-context";
import { getAccount, requestFaucet, submitTransaction } from "./chain-api";
import { useQuery, useQueryClient } from "@tanstack/react-query";

interface WalletState extends Keypair {
  mnemonic?: string;
}

interface WalletCtx {
  wallet: WalletState | null;
  create: () => WalletState & { mnemonic: string };
  importKey: (priv: string) => WalletState;
  importMnemonic: (phrase: string) => WalletState;
  lock: () => void;
  send: (to: string, amount: number, fee: number) => Promise<{ ok: boolean; error?: string }>;
  faucet: () => Promise<{ ok: boolean; error?: string }>;
  balance: number;
  nonce: number;
}

const Ctx = createContext<WalletCtx | null>(null);
const storageKey = (n: string) => `eq.wallet.${n}`;

export function WalletProvider({ children }: { children: ReactNode }) {
  const { network, snap } = useNetwork();
  const qc = useQueryClient();
  const [wallet, setWallet] = useState<WalletState | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem(storageKey(network));
    if (!raw) {
      setWallet(null);
      return;
    }
    try {
      const parsed = JSON.parse(raw) as WalletState;
      if (parsed.privateKey) setWallet(parsed);
    } catch {
      setWallet(null);
    }
  }, [network]);

  const persist = (w: WalletState) => {
    const stored = { privateKey: w.privateKey, publicKey: w.publicKey, address: w.address };
    localStorage.setItem(storageKey(network), JSON.stringify(stored));
    setWallet(w);
  };

  const { data: account } = useQuery({
    queryKey: ["account", network, wallet?.address],
    queryFn: () => getAccount({ data: { network, address: wallet!.address } }),
    enabled: !!wallet,
    refetchInterval: 3000,
  });

  const create = useCallback(() => {
    const phrase = generatePhrase();
    const w = walletFromMnemonic(phrase);
    persist(w);
    return w;
  }, [network]);

  const importKey = useCallback(
    (priv: string) => {
      const clean = priv.trim().replace(/^0x/, "");
      const w = keypairFromSeed(hexToBytes(clean));
      persist(w);
      return w;
    },
    [network],
  );

  const importMnemonic = useCallback(
    (phrase: string) => {
      const w = walletFromMnemonic(phrase.trim());
      persist(w);
      return w;
    },
    [network],
  );

  const lock = () => {
    localStorage.removeItem(storageKey(network));
    setWallet(null);
  };

  const send = async (to: string, amount: number, fee: number) => {
    if (!wallet) return { ok: false, error: "no wallet" };
    const nonce = account?.nonce ?? 0;
    const tx = signTx(wallet, {
      to: to.toLowerCase().replace(/^0x/, ""),
      amount,
      fee,
      nonce,
      chainId: snap?.params.chainId ?? (network === "mainnet" ? 1 : 2),
    });
    const res = await submitTransaction({
      data: {
        network,
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        nonce: tx.nonce,
        timestamp: tx.timestamp,
        signature: tx.signature,
        publicKey: tx.publicKey,
      },
    });
    await qc.invalidateQueries({ queryKey: ["snapshot", network] });
    await qc.invalidateQueries({ queryKey: ["account", network, wallet.address] });
    return res;
  };

  const faucet = async () => {
    if (!wallet) return { ok: false, error: "no wallet" };
    const res = await requestFaucet({ data: { network, address: wallet.address } });
    await qc.invalidateQueries({ queryKey: ["snapshot", network] });
    return res;
  };

  const value = useMemo(
    () => ({
      wallet,
      create,
      importKey,
      importMnemonic,
      lock,
      send,
      faucet,
      balance: account?.balance ?? 0,
      nonce: account?.nonce ?? 0,
    }),
    [wallet, create, importKey, importMnemonic, account, snap, network],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet outside provider");
  return ctx;
}

void generateKeypair;
