import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import {
  generateWallet, importFromPrivKey, signTx, mnemonicToWallet,
  encryptKeystore, decryptKeystore, serializeKeystore, parseKeystore,
  createMultisigAddress, signForMultisig, verifyMultisigThreshold,
  type EncryptedKeystore, type MultisigConfig, type MultisigSignature,
} from "./crypto";
import { LedgerTransport, type LedgerDevice } from "./ledger";
import { useBroadcastTransaction } from "@workspace/api-client-react";

// ── Wallet types ──────────────────────────────────────────────────────────────

export type WalletType = "raw" | "mnemonic" | "multisig" | "hardware";

export interface BaseWallet {
  address: string;
  publicKey: string;
  walletType: WalletType;
}

export interface SingleKeyWallet extends BaseWallet {
  walletType: "raw" | "mnemonic";
  privateKey: string;
  mnemonic?: string;
  derivationPath?: string;
  encrypted?: boolean;
}

export interface MultisigWallet extends BaseWallet {
  walletType: "multisig";
  multisigConfig: MultisigConfig;
  ownPrivateKey?: string;
}

export interface HardwareWallet extends BaseWallet {
  walletType: "hardware";
  derivationPath: string;
  deviceName: string;
}

export type WalletState = SingleKeyWallet | MultisigWallet | HardwareWallet;

const STORAGE_KEY = "equ_wallet";
const KEYSTORE_KEY = "equ_keystore";

// ── Context ───────────────────────────────────────────────────────────────────

interface WalletContextValue {
  wallet: WalletState | null;

  // Creation
  createWallet: () => Promise<WalletState>;
  createFromMnemonic: (mnemonic: string, accountIndex?: number) => Promise<WalletState>;
  importWallet: (privHex: string) => Promise<WalletState>;
  importFromMnemonic: (mnemonic: string) => Promise<WalletState>;
  createMultisig: (pubKeys: string[], threshold: number, ownPrivKey?: string) => Promise<WalletState>;

  // Encrypted keystore
  saveEncryptedKeystore: (secret: string, password: string) => Promise<void>;
  loadEncryptedKeystore: (password: string) => Promise<WalletState>;
  hasEncryptedKeystore: () => boolean;
  exportKeystore: () => Promise<string | null>;

  // Hardware wallet
  connectLedger: (accountIndex?: number) => Promise<WalletState>;
  ledgerDevice: LedgerDevice | null;

  // Wallet management
  clearWallet: () => void;

  // Transactions
  signAndBroadcast: (to: string, amount: number, fee: number, nonce: number) => Promise<any>;
  collectMultisigSig: (to: string, amount: number, fee: number, nonce: number) => Promise<MultisigSignature>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [ledgerDevice, setLedgerDevice] = useState<LedgerDevice | null>(null);
  const broadcastTx = useBroadcastTransaction();
  const ledger = new LedgerTransport();

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try { setWallet(JSON.parse(stored)); } catch { /* ignore */ }
    }
  }, []);

  const save = useCallback((w: WalletState) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
    setWallet(w);
  }, []);

  // ── Creation ──────────────────────────────────────────────────────────────

  const createWallet = async (): Promise<WalletState> => {
    const w = await generateWallet();
    const sw: SingleKeyWallet = { ...w, walletType: "raw" };
    save(sw);
    return sw;
  };

  const createFromMnemonic = async (mnemonic: string, accountIndex = 0): Promise<WalletState> => {
    const w = await mnemonicToWallet(mnemonic, accountIndex);
    const sw: SingleKeyWallet = { ...w, walletType: "mnemonic" };
    save(sw);
    return sw;
  };

  const importWallet = async (privHex: string): Promise<WalletState> => {
    const w = await importFromPrivKey(privHex);
    const sw: SingleKeyWallet = { ...w, walletType: "raw" };
    save(sw);
    return sw;
  };

  const importFromMnemonic = async (mnemonic: string): Promise<WalletState> => {
    const w = await mnemonicToWallet(mnemonic);
    const sw: SingleKeyWallet = { ...w, walletType: "mnemonic" };
    save(sw);
    return sw;
  };

  const createMultisig = async (
    pubKeys: string[],
    threshold: number,
    ownPrivKey?: string,
  ): Promise<WalletState> => {
    const config = await createMultisigAddress(pubKeys, threshold);
    let ownPublicKey = "";
    if (ownPrivKey) {
      const { publicKey } = await importFromPrivKey(ownPrivKey);
      ownPublicKey = publicKey;
    }
    const mw: MultisigWallet = {
      walletType: "multisig",
      address: config.address,
      publicKey: ownPublicKey,
      multisigConfig: config,
      ownPrivateKey: ownPrivKey,
    };
    save(mw);
    return mw;
  };

  // ── Encrypted keystore ────────────────────────────────────────────────────

  const saveEncryptedKeystore = async (secret: string, password: string): Promise<void> => {
    const ks = await encryptKeystore(secret, password);
    localStorage.setItem(KEYSTORE_KEY, serializeKeystore(ks));
  };

  const loadEncryptedKeystore = async (password: string): Promise<WalletState> => {
    const raw = localStorage.getItem(KEYSTORE_KEY);
    if (!raw) throw new Error("No encrypted keystore found");
    const ks = parseKeystore(raw);
    const secret = await decryptKeystore(ks, password);
    // Secret may be a mnemonic or a private key
    if (secret.split(" ").length >= 12) {
      return importFromMnemonic(secret);
    }
    return importWallet(secret);
  };

  const hasEncryptedKeystore = (): boolean => {
    return localStorage.getItem(KEYSTORE_KEY) !== null;
  };

  const exportKeystore = async (): Promise<string | null> => {
    return localStorage.getItem(KEYSTORE_KEY);
  };

  // ── Hardware wallet ───────────────────────────────────────────────────────

  const connectLedger = async (accountIndex = 0): Promise<WalletState> => {
    const device = await ledger.connect();
    setLedgerDevice(device);
    const { publicKey, address, derivationPath } = await ledger.getPublicKey(accountIndex);
    const hw: HardwareWallet = {
      walletType: "hardware",
      address,
      publicKey,
      derivationPath,
      deviceName: device.deviceName,
    };
    save(hw);
    return hw;
  };

  // ── Clear ─────────────────────────────────────────────────────────────────

  const clearWallet = () => {
    localStorage.removeItem(STORAGE_KEY);
    setWallet(null);
    setLedgerDevice(null);
  };

  // ── Transactions ──────────────────────────────────────────────────────────

  const signAndBroadcast = async (
    to: string,
    amount: number,
    fee: number,
    nonce: number,
  ): Promise<any> => {
    if (!wallet) throw new Error("No wallet loaded");

    let signature: string;

    if (wallet.walletType === "hardware") {
      const txBytes = new TextEncoder().encode(
        `${wallet.address}${to}${amount}${fee}${nonce}`,
      );
      const result = await ledger.signTransaction(txBytes);
      signature = result.signature;
    } else if (wallet.walletType === "multisig") {
      const mw = wallet as MultisigWallet;
      if (!mw.ownPrivateKey) throw new Error("No signing key loaded for multisig");
      const sig = await signForMultisig(mw.ownPrivateKey, wallet.address, to, amount, fee, nonce);
      signature = sig.signature;
    } else {
      const sw = wallet as SingleKeyWallet;
      signature = await signTx(sw.privateKey, wallet.address, to, amount, fee, nonce);
    }

    return broadcastTx.mutateAsync({
      data: {
        from: wallet.address,
        to,
        amount,
        fee,
        nonce,
        signature,
        publicKey: wallet.publicKey,
      },
    });
  };

  const collectMultisigSig = async (
    to: string,
    amount: number,
    fee: number,
    nonce: number,
  ): Promise<MultisigSignature> => {
    if (!wallet || wallet.walletType !== "multisig") {
      throw new Error("Not a multisig wallet");
    }
    const mw = wallet as MultisigWallet;
    if (!mw.ownPrivateKey) throw new Error("No signing key loaded");
    return signForMultisig(mw.ownPrivateKey, wallet.address, to, amount, fee, nonce);
  };

  return (
    <WalletContext.Provider
      value={{
        wallet,
        createWallet,
        createFromMnemonic,
        importWallet,
        importFromMnemonic,
        createMultisig,
        saveEncryptedKeystore,
        loadEncryptedKeystore,
        hasEncryptedKeystore,
        exportKeystore,
        connectLedger,
        ledgerDevice,
        clearWallet,
        signAndBroadcast,
        collectMultisigSig,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
