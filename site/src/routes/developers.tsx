import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useNetwork } from "@/lib/network-context";

export const Route = createFileRoute("/developers")({ component: Developers });

function Developers() {
  const { snap, network } = useNetwork();
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-4xl tracking-tight">Developers</h1>
        <p className="mt-2 max-w-2xl text-muted">
          This kernel is the public runtime body. The reference consensus engine and
          Android FFI live in CreoDAMO/Equilibrium-Vision. Address derivation and
          chain_id replay protection are shared.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Networks">
          <p>Testnet chain_id 2 · 8s blocks · faucet on.</p>
          <p>Mainnet chain_id 1 · 15s blocks · fail-closed, no faucet.</p>
          <p>Current: {network} at height {snap?.height ?? "—"}.</p>
        </Card>
        <Card title="Crypto">
          <p>Ed25519 signatures. SHA-256(pubkey)[..20] addresses.</p>
          <p>BIP-39 + SLIP-0010 path m/44'/600'/account'/0'/index'.</p>
          <p>Signing bytes include chain_id (u64 LE) last.</p>
        </Card>
        <Card title="Admission">
          <p>Canonical residual below network threshold.</p>
          <p>VerifyStationaryEvidence required. No claimed residuals.</p>
          <p>Reward = 50,000,000 × min(1/(R+1e-6), 1).</p>
        </Card>
        <Card title="Source">
          <p>github.com/CreoDAMO/Equilibrium-Vision</p>
          <p>Rust crate equilibrium/ · TS artifacts/api-server</p>
          <p>Android JNI miner + in-process libp2p swarm.</p>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface p-5 shadow-[var(--shadow-border)]">
      <h2 className="font-display text-xl">{title}</h2>
      <div className="mt-3 space-y-2 text-sm text-muted">{children}</div>
    </div>
  );
}
