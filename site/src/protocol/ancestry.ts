/**
 * Ancestry is a chain back to genesis.
 * Block 0 names the genesis state. Each later block names the carried state of the block before it.
 * An accumulated proof is not this check. A checkpoint is not a root.
 */
import { fullStateId } from "./fullstate";
import { initialOmega } from "./constitution";
import type { BlockRecord, NetworkId } from "./types";

export function genesisStateId(network: NetworkId): string {
  return fullStateId(initialOmega(network));
}

export function ancestryBreak(blocks: BlockRecord[], genesisId: string): string | null {
  if (blocks.length === 0) return null;
  const first = blocks[0]?.statement;
  if (!first) return "statement is absent";
  if (first.predecessor !== genesisId) return "predecessor is not genesis";
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]?.statement;
    const statement = blocks[i]?.statement;
    if (!prev || !statement) return "statement is absent";
    if (statement.predecessor !== prev.carried) return "predecessor is not the carried chain";
  }
  return null;
}
