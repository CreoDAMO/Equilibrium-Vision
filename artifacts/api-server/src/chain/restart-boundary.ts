/**
 * Restart boundary.
 * A snapshot names one block by hash. Height is not unique: an operational
 * row and an evidence row may share it. The first row at that height is not
 * the anchor.
 * Evidence at or below the snapshot is already in the saved Ω. Only later
 * evidence is replayed. A full restore (no snapshot) is the historical path.
 * Pruning may delete a row only when the snapshot's own block survives.
 */

export type AnchorMiss = "missing" | "height-mismatch" | "ambiguous";

export function selectSnapshotAnchor<T extends { hash: string; height: number }>(
  blocks: readonly T[],
  snapshot: { height: number; blockHash: string },
): { ok: true; block: T } | { ok: false; reason: AnchorMiss } {
  const matches = blocks.filter((block) => block.hash === snapshot.blockHash);
  if (matches.length === 0) return { ok: false, reason: "missing" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  const block = matches[0]!;
  if (block.height !== snapshot.height) return { ok: false, reason: "height-mismatch" };
  return { ok: true, block };
}

/** Parent walk from the anchor. A same-height sibling that is not this hash is not installed. */
export function chainThroughAnchor<T extends { hash: string; height: number; prevHash: string }>(
  blocks: readonly T[],
  anchor: T,
): T[] {
  const byHash = new Map<string, T>();
  for (const block of blocks) {
    if (!byHash.has(block.hash)) byHash.set(block.hash, block);
  }
  const chain: T[] = [];
  const seen = new Set<string>();
  let cursor: T | undefined = anchor;
  while (cursor && !seen.has(cursor.hash)) {
    seen.add(cursor.hash);
    chain.push(cursor);
    cursor = byHash.get(cursor.prevHash);
  }
  return chain.reverse();
}

/**
 * Snapshot path: evidence strictly after the snapshot height.
 * No snapshot: every evidence row, in height then hash order.
 */
export function evidenceToReplay<T extends { height: number; hash: string; evidence?: unknown }>(
  blocks: readonly T[],
  snapshotHeight: number | null,
): T[] {
  const rows = blocks.filter((block) => {
    if (!block.evidence) return false;
    if (snapshotHeight === null) return true;
    return block.height > snapshotHeight;
  });
  return rows.sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
}

export function snapshotCoversPrune(input: {
  tipHeight: number;
  keepBlocks: number;
  snapshot: { height: number; blockHash: string } | null;
  anchor: { hash: string; height: number } | null;
}): { pruneBelow: number; allowed: boolean; reason: string } {
  const pruneBelow = input.tipHeight - input.keepBlocks;
  if (pruneBelow <= 0) return { pruneBelow, allowed: false, reason: "nothing to prune" };
  if (!input.snapshot || !input.anchor) {
    return { pruneBelow, allowed: false, reason: "snapshot anchor missing" };
  }
  if (input.anchor.hash !== input.snapshot.blockHash || input.anchor.height !== input.snapshot.height) {
    return { pruneBelow, allowed: false, reason: "snapshot anchor does not match the block row" };
  }
  const survives = input.anchor.height === 0 || input.anchor.height >= pruneBelow;
  if (!survives) return { pruneBelow, allowed: false, reason: "snapshot anchor would be deleted" };
  return { pruneBelow, allowed: true, reason: "anchor retained" };
}
