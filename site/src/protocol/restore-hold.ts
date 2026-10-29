/** A refused replay is named. It is not a new chain, and it is not written over the saved one. */
export const HELD_STATUS = 503;

export type NetworkName = "testnet" | "mainnet";

export function heldRestore(network: string, reason: string, persistence: string, commit: string | null) {
  return {
    network,
    restored: false as const,
    persisted: true,
    reason,
    persistence,
    note: "The saved chain was not replaced. This process will not mine over it.",
    deployment: { commit },
  };
}

/** A RestoreRefused hold stops that network only. Any other failure is not this gate. */
export function networkMayMine(hold: Partial<Record<NetworkName, string>>, network: NetworkName): boolean {
  return hold[network] === undefined;
}

/** The one-second miner. A held network is not asked to tick, and nothing is written for it. */
export function mineInterval<T extends { tick: () => unknown }>(
  hold: Partial<Record<NetworkName, string>>,
  nodes: Partial<Record<NetworkName, T | undefined>>,
  onMined: (network: NetworkName, node: T) => void,
): void {
  for (const network of ["testnet", "mainnet"] as const) {
    if (!networkMayMine(hold, network)) continue;
    const node = nodes[network];
    if (!node) continue;
    if (node.tick()) onMined(network, node);
  }
}
