import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useNetwork } from "@/lib/network-context";
import { formatSci } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";
import { Badge } from "./ui/badge";

const NAV = [
  { to: "/", label: "Organism" },
  { to: "/explorer", label: "Explorer" },
  { to: "/wallet", label: "Wallet" },
  { to: "/verify", label: "Verify" },
  { to: "/experiments", label: "Experiments" },
  { to: "/protocol", label: "Protocol" },
];

const MORE = [
  { to: "/validators", label: "Validators" },
  { to: "/mempool", label: "Mempool" },
  { to: "/state", label: "State" },
  { to: "/dex", label: "DEX" },
  { to: "/loop", label: "Loop" },
  { to: "/mesh", label: "Mesh" },
  { to: "/contracts", label: "Contracts" },
  { to: "/library", label: "Library" },
  { to: "/audit", label: "Claim audit" },
  { to: "/research", label: "Research" },
  { to: "/mobile", label: "Mobile" },
  { to: "/developers", label: "Developers" },
];

export function Shell({ children }: { children: ReactNode }) {
  const { network, setNetwork, snap } = useNetwork();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" className="lg:hidden size-11 px-0" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent title="Equilibrium">
              <NavList pathname={pathname} stacked />
            </SheetContent>
          </Sheet>

          <Link to="/" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-full shadow-[var(--shadow-border)]">
              <svg viewBox="0 0 24 24" className="size-4 text-accent" aria-hidden>
                <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M7 12h10" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span className="font-display text-lg tracking-tight">Equilibrium</span>
          </Link>

          <nav className="ml-4 hidden items-center gap-1 lg:flex">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "rounded-md px-3 py-2 text-sm text-muted hover:text-fg",
                  pathname === item.to && "bg-surface text-fg",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            {snap ? (
              <div className="hidden items-center gap-3 font-mono text-xs text-muted sm:flex">
                <span className="tabular">#{snap.height}</span>
                <span>R {formatSci(snap.lastResidual, 2)}</span>
              </div>
            ) : null}
            <div className="flex rounded-full bg-surface p-1 shadow-[var(--shadow-border)]">
              {(["testnet", "mainnet"] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setNetwork(n)}
                  className={cn(
                    "min-h-9 rounded-full px-3 text-xs capitalize",
                    network === n ? "bg-accent text-accent-fg" : "text-muted",
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-8">{children}</main>
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
          <p>equilibrium.site · the theory is the map · the implementation is the territory</p>
          <div className="flex flex-wrap gap-3">
            {MORE.map((m) => (
              <Link key={m.to} to={m.to} className="hover:text-fg">
                {m.label}
              </Link>
            ))}
            <a href="https://github.com/CreoDAMO/Equilibrium-Vision" className="hover:text-fg">
              Source
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function NavList({ pathname, stacked }: { pathname: string; stacked?: boolean }) {
  const items = [...NAV, ...MORE];
  return (
    <div className={cn(stacked ? "flex flex-col gap-1" : "flex gap-2")}>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={cn(
            "rounded-md px-3 py-3 text-sm",
            pathname === item.to ? "bg-surface text-fg" : "text-muted",
          )}
        >
          {item.label}
        </Link>
      ))}
      <Badge tone="muted" className="mt-4 w-fit">
        Proof of Stationarity
      </Badge>
    </div>
  );
}
