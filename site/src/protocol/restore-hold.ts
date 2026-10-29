/** A refused replay is named. It is not a new chain, and it is not written over the saved one. */
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
