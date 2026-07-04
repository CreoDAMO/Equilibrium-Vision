import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { Search, Activity, Box, ListTree, Users, Layers, Zap, Wallet, Shield, Vote, Droplets } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function Layout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const [search, setSearch] = useState("");

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!search.trim()) return;
    
    const query = search.trim();
    if (query.length === 64) {
      // Could be block hash or tx hash. We'll default to block, or if we had a smart search we'd check both.
      // Let's route to tx first if they prefix it, but assuming we just route to search results or try tx first.
      setLocation(`/tx/${query}`);
    } else if (query.length === 40) {
      setLocation(`/address/${query}`);
    } else if (!isNaN(Number(query))) {
      setLocation(`/blocks/${query}`);
    } else {
      setLocation(`/blocks/${query}`);
    }
  };

  const navLinks = [
    { href: "/", label: "Dashboard", icon: <Activity className="w-4 h-4 mr-2" /> },
    { href: "/blocks", label: "Blocks", icon: <Box className="w-4 h-4 mr-2" /> },
    { href: "/mempool", label: "Mempool", icon: <ListTree className="w-4 h-4 mr-2" /> },
    { href: "/network", label: "Network", icon: <Users className="w-4 h-4 mr-2" /> },
    { href: "/validators", label: "Validators", icon: <Shield className="w-4 h-4 mr-2" /> },
    { href: "/governance", label: "Governance", icon: <Vote className="w-4 h-4 mr-2" /> },
    { href: "/faucet", label: "Faucet", icon: <Droplets className="w-4 h-4 mr-2" /> },
    { href: "/wallet", label: "Wallet", icon: <Wallet className="w-4 h-4 mr-2" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 text-primary font-bold text-lg">
              <Layers className="w-6 h-6" />
              <span>EQU Explorer</span>
            </Link>

            <nav className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-muted ${
                    location === link.href ? "bg-muted text-foreground" : "text-muted-foreground"
                  }`}
                >
                  {link.icon}
                  {link.label}
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
    </div>
  );
}
