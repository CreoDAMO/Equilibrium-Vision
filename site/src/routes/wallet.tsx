import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useWallet } from "@/lib/wallet-context";
import { useNetwork } from "@/lib/network-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Stat } from "@/components/stat";
import { formatAmount } from "@/lib/format";

export const Route = createFileRoute("/wallet")({ component: WalletPage });

function WalletPage() {
  const { wallet, create, importKey, importMnemonic, lock, send, faucet, balance, nonce } = useWallet();
  const { network, snap } = useNetwork();
  const [phrase, setPhrase] = useState<string | null>(null);
  const [priv, setPriv] = useState("");
  const [mn, setMn] = useState("");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("1000");
  const [fee, setFee] = useState("100");

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Wallet</h1>
        <p className="mt-2 max-w-xl text-muted">
          Self-custody Ed25519 keys. Addresses are SHA-256(pubkey)[..20] — the same
          derivation as the Rust and TypeScript stacks. Keys never leave this browser.
        </p>
      </header>

      {!wallet ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <h2 className="font-display text-xl">Create</h2>
            <p className="mt-2 text-sm text-muted">BIP-39 mnemonic, path m/44'/600'/0'/0'/0'.</p>
            <Button
              className="mt-4"
              onClick={() => {
                const w = create();
                setPhrase(w.mnemonic);
                toast.success("Wallet created — copy the phrase now");
              }}
            >
              Generate wallet
            </Button>
            {phrase ? (
              <pre className="mt-4 whitespace-pre-wrap rounded-lg bg-bg-elevated p-4 font-mono text-sm">
                {phrase}
              </pre>
            ) : null}
          </div>
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
            <h2 className="font-display text-xl">Import</h2>
            <Input placeholder="Private key hex" value={priv} onChange={(e) => setPriv(e.target.value)} />
            <Button
              variant="secondary"
              onClick={() => {
                try {
                  importKey(priv);
                  toast.success("Imported");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Import failed");
                }
              }}
            >
              Import key
            </Button>
            <Input placeholder="Mnemonic phrase" value={mn} onChange={(e) => setMn(e.target.value)} />
            <Button
              variant="secondary"
              onClick={() => {
                try {
                  importMnemonic(mn);
                  toast.success("Imported");
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Invalid phrase");
                }
              }}
            >
              Import phrase
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Balance" value={formatAmount(balance)} />
            <Stat label="Nonce" value={nonce} />
            <Stat label="Network" value={network} hint={`chain id ${snap?.params.chainId ?? "—"}`} />
            <Stat
              label="Faucet"
              value={snap?.params.allowFaucet ? formatAmount(snap.params.faucetAmount) : "closed"}
              hint={snap?.params.allowFaucet ? "testnet drip" : "mainnet refuses"}
            />
          </div>
          <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
            <p className="text-xs uppercase tracking-wider text-subtle">Address</p>
            <p className="mt-1 break-all font-mono text-sm">{wallet.address}</p>
            <Link className="mt-2 inline-block text-sm text-accent" to="/address/$addr" params={{ addr: wallet.address }}>
              View on explorer
            </Link>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
              <h2 className="font-display text-xl">Send</h2>
              <Input placeholder="Recipient address" value={to} onChange={(e) => setTo(e.target.value)} />
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Input value={fee} onChange={(e) => setFee(e.target.value)} />
              <Button
                onClick={async () => {
                  const res = await send(to, Number(amount), Number(fee));
                  if (res.ok) toast.success("Queued in mempool");
                  else toast.error(res.error ?? "Rejected");
                }}
              >
                Sign and broadcast
              </Button>
            </div>
            <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)] space-y-3">
              <h2 className="font-display text-xl">Faucet</h2>
              <p className="text-sm text-muted">
                Testnet only. Credits 1,000,000 units from the treasury. Mainnet refuses.
              </p>
              <Button
                variant="secondary"
                onClick={async () => {
                  const res = await faucet();
                  if (res.ok) toast.success("Faucet queued");
                  else toast.error(res.error ?? "Faucet refused");
                }}
              >
                Request testnet funds
              </Button>
              <Button variant="ghost" onClick={lock}>
                Lock wallet
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
