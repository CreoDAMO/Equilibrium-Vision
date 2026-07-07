import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { Search, Activity, Box, ListTree, Users, Wallet, Shield, ShieldCheck, Vote, Droplets, Code2, Coins, ArrowRightLeft, Layers, ChevronDown, Globe, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { setBaseUrl } from "@workspace/api-client-react";

// ── Persistent network config ─────────────────────────────────────────────────

const STORAGE_KEY = "equ_network";

interface NetworkPreset {
  name: string;
  url: string; // empty = same-origin
}

const DEFAULT_PRESETS: NetworkPreset[] = [
  { name: "Testnet", url: "" },
  { name: "Mainnet", url: import.meta.env.VITE_MAINNET_URL ?? "" },
];

function readStoredNetwork(): NetworkPreset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as NetworkPreset;
  } catch {}
  return DEFAULT_PRESETS[0];
}

function saveNetwork(preset: NetworkPreset) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preset));
}

// ── Badge colour ──────────────────────────────────────────────────────────────

function networkBadgeClass(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("mainnet") || lower === "main") return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30";
  if (lower.includes("testnet") || lower === "test") return "bg-amber-500/15 text-amber-600 border-amber-500/30";
  return "bg-blue-500/15 text-blue-600 border-blue-500/30";
}

// ── Component ─────────────────────────────────────────────────────────────────

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  // Network switcher state
  const [currentNetwork, setCurrentNetwork] = useState<NetworkPreset>(readStoredNetwork);
  const [showNetworkDialog, setShowNetworkDialog] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<NetworkPreset | null>(null);
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!search.trim()) return;
    
    const query = search.trim().toLowerCase();
    if (query.length === 64 && /^[0-9a-f]+$/.test(query)) {
      setLocation(`/search/${query}`);
    } else if (query.length === 40 && /^[0-9a-f]+$/.test(query)) {
      setLocation(`/address/${query}`);
    } else if (/^\d+$/.test(query)) {
      setLocation(`/blocks/${query}`);
    } else {
      setLocation(`/blocks/${query}`);
    }
  };

  const openNetworkDialog = () => {
    setSelectedPreset(currentNetwork);
    setCustomName("");
    setCustomUrl("");
    setShowNetworkDialog(true);
  };

  const handleSwitchNetwork = () => {
    const target: NetworkPreset = selectedPreset?.name === "__custom__"
      ? { name: customName.trim() || "Custom", url: customUrl.trim() }
      : (selectedPreset ?? currentNetwork);

    saveNetwork(target);
    setBaseUrl(target.url || null);
    setCurrentNetwork(target);
    setShowNetworkDialog(false);
    // Reload so all live queries re-fetch against the new base URL
    window.location.reload();
  };

  // Determine if custom row should be active
  const isCustom = !DEFAULT_PRESETS.some(p => p.name === currentNetwork.name && p.url === currentNetwork.url);

  const navLinks = [
    { href: "/", label: "Dashboard", icon: <Activity className="w-4 h-4" /> },
    { href: "/blocks", label: "Blocks", icon: <Box className="w-4 h-4" /> },
    { href: "/mempool", label: "Mempool", icon: <ListTree className="w-4 h-4" /> },
    { href: "/network", label: "Network", icon: <Users className="w-4 h-4" /> },
    { href: "/validators", label: "Validators", icon: <Shield className="w-4 h-4" /> },
    { href: "/staking", label: "Staking", icon: <Coins className="w-4 h-4" /> },
    { href: "/dex", label: "DEX", icon: <ArrowRightLeft className="w-4 h-4" /> },
    { href: "/governance", label: "Governance", icon: <Vote className="w-4 h-4" /> },
    { href: "/faucet", label: "Faucet", icon: <Droplets className="w-4 h-4" /> },
    { href: "/wallet", label: "Wallet", icon: <Wallet className="w-4 h-4" /> },
    { href: "/contracts", label: "Contracts", icon: <Code2 className="w-4 h-4" /> },
    { href: "/admin/multisig", label: "Admin", icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-6">
            {/* Logo + network badge */}
            <div className="flex items-center gap-2">
              <Link href="/" className="flex items-center gap-2 text-primary font-bold text-lg">
                <Layers className="w-6 h-6" />
                <span>EQU Explorer</span>
              </Link>
              <button
                onClick={openNetworkDialog}
                className={`flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border transition-opacity hover:opacity-80 ${networkBadgeClass(currentNetwork.name)}`}
              >
                <Globe className="w-3 h-3" />
                {currentNetwork.name}
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>

            <nav className="hidden md:flex items-center gap-0.5">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-label={link.label}
                  title={link.label}
                  className={`flex items-center gap-1.5 px-2 2xl:px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted ${
                    location === link.href ? "bg-muted text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {link.icon}
                  <span className="hidden 2xl:inline" aria-hidden="true">{link.label}</span>
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-4">
            <form onSubmit={handleSearch} className="relative w-64 md:w-80">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search hash, address, height..."
                className="pl-9 bg-muted/50 border-transparent focus:bg-background"
              />
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
      
      <footer className="border-t py-8 bg-card mt-auto text-center text-sm text-muted-foreground">
        <div className="container mx-auto">
          <p>Equilibrium Proof-of-Stationarity Network Explorer</p>
        </div>
      </footer>

      {/* ── Network switcher dialog ────────────────────────────────────────── */}
      <Dialog open={showNetworkDialog} onOpenChange={setShowNetworkDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="w-4 h-4" /> Switch Network
            </DialogTitle>
            <DialogDescription>
              Choose a network to connect this explorer to. The page will reload after switching.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-2">
            {DEFAULT_PRESETS.filter(p => p.url !== undefined).map((preset) => {
              const isSel = selectedPreset?.name === preset.name && selectedPreset?.url === preset.url;
              return (
                <button
                  key={preset.name}
                  onClick={() => setSelectedPreset(preset)}
                  className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 text-sm transition-colors ${
                    isSel ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${networkBadgeClass(preset.name)}`}>
                      {preset.name}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {preset.url || "same server"}
                    </span>
                  </div>
                  {isSel && <Check className="w-4 h-4 text-primary" />}
                </button>
              );
            })}

            {/* Custom option */}
            <button
              onClick={() => setSelectedPreset({ name: "__custom__", url: "" })}
              className={`w-full flex items-center justify-between rounded-lg border px-4 py-3 text-sm transition-colors ${
                selectedPreset?.name === "__custom__" ? "border-primary bg-primary/5" : "hover:bg-muted/50"
              }`}
            >
              <span className="text-muted-foreground">Custom endpoint…</span>
              {selectedPreset?.name === "__custom__" && <Check className="w-4 h-4 text-primary" />}
            </button>

            {selectedPreset?.name === "__custom__" && (
              <div className="space-y-2 pt-1 pl-1">
                <Input
                  placeholder="Network name (e.g. Staging)"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
                <Input
                  placeholder="API base URL (e.g. https://api.example.com)"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Leave URL blank to use the current server.</p>
              </div>
            )}

            {/* Show current if it's a custom entry not in presets */}
            {isCustom && selectedPreset?.name !== "__custom__" && (
              <div className="rounded-lg border px-4 py-2 text-xs text-muted-foreground bg-muted/30">
                Currently connected to: <span className="font-medium text-foreground">{currentNetwork.name}</span>
                {currentNetwork.url && <> ({currentNetwork.url})</>}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNetworkDialog(false)}>Cancel</Button>
            <Button
              onClick={handleSwitchNetwork}
              disabled={
                selectedPreset?.name === "__custom__"
                  ? false
                  : selectedPreset?.name === currentNetwork.name && selectedPreset?.url === currentNetwork.url
              }
            >
              Switch &amp; Reload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
