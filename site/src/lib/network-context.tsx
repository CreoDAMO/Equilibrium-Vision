import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSnapshot } from "@/lib/chain-api";
import type { ChainSnapshot, NetworkId } from "@/protocol/types";

interface NetworkCtx {
  network: NetworkId;
  setNetwork: (n: NetworkId) => void;
  snap: ChainSnapshot | undefined;
  isLoading: boolean;
}

const Ctx = createContext<NetworkCtx | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setNetworkState] = useState<NetworkId>("testnet");

  useEffect(() => {
    const saved = localStorage.getItem("eq.network");
    if (saved === "mainnet" || saved === "testnet") setNetworkState(saved);
  }, []);

  const setNetwork = (n: NetworkId) => {
    setNetworkState(n);
    localStorage.setItem("eq.network", n);
  };

  const { data: snap, isLoading } = useQuery({
    queryKey: ["snapshot", network],
    queryFn: () => getSnapshot({ data: { network } }),
    refetchInterval: 2000,
  });

  const value = useMemo(
    () => ({ network, setNetwork, snap, isLoading }),
    [network, snap, isLoading],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNetwork() {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return {
      network: "testnet" as NetworkId,
      setNetwork: () => {},
      snap: undefined,
      isLoading: true,
    };
  }
  return ctx;
}
