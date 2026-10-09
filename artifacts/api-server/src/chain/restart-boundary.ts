/**
 * Restart boundary.
 * A snapshot names one block by hash. Height is not unique: an operational
 * row and an evidence row may share it. The first row at that height is not
 * the anchor.
 * Evidence at or below the snapshot is already in the saved Ω. Only later
 * evidence is replayed. A full restore (no snapshot) is the historical path.
 * Pruning may delete a row only when the snapshot's own block survives.
 *
 * Post-snapshot rows are not "later" because their height is greater.
 * They have to descend from the anchor by parent hash. Two children of one
 * parent are a fork, and hash order does not choose one.
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

type LineageRow = { hash: string; height: number; prevHash: string; evidence?: unknown };

export interface Continuation<T> {
  /** Unique descendants of the anchor, parent first. Empty once the next step forks. */
  blocks: T[];
  /** Descendants of a fork. They are not a chosen canonical branch. */
  retained: T[];
  /** Operational rows that do not descend from the anchor. Height is not ancestry. */
  ignored: T[];
  /** Set when more than one child extends the same parent. No child is chosen. */
  fork: { children: string[] } | null;
}

/**
 * Rows that extend the anchor by parent hash.
 * A row above the anchor's height is not included unless its parent walk reaches the anchor.
 * Two children of one parent are a fork: neither is selected by hash order.
 */
export function continuationAfterAnchor<T extends LineageRow>(
  blocks: readonly T[],
  anchor: { hash: string },
): Continuation<T> {
  const operational = blocks.filter((block) => !block.evidence && block.hash !== anchor.hash);
  const children = new Map<string, T[]>();
  for (const block of operational) {
    const list = children.get(block.prevHash);
    if (list) list.push(block);
    else children.set(block.prevHash, [block]);
  }
  const selected: T[] = [];
  const retained: T[] = [];
  const seen = new Set<string>([anchor.hash]);
  let parent = anchor.hash;
  let fork: { children: string[] } | null = null;
  while (!fork) {
    const next = children.get(parent) ?? [];
    if (next.length === 0) break;
    if (next.length > 1) {
      fork = { children: next.map((block) => block.hash) };
      const stack = [...next];
      while (stack.length > 0) {
        const block = stack.pop()!;
        if (seen.has(block.hash)) continue;
        seen.add(block.hash);
        retained.push(block);
        for (const child of children.get(block.hash) ?? []) stack.push(child);
      }
      break;
    }
    const only = next[0]!;
    if (seen.has(only.hash)) break;
    seen.add(only.hash);
    selected.push(only);
    parent = only.hash;
  }
  return {
    blocks: selected,
    retained,
    ignored: operational.filter((block) => !seen.has(block.hash)),
    fork,
  };
}

/**
 * Full replay from the single height-0 row, following parent hashes.
 * A same-height sibling stops the canonical prefix. It is retained, not chosen.
 * A row that does not connect to that walk is an orphan.
 * Input order does not change the replay hashes.
 */
export function operationalReplaySet<T extends LineageRow>(
  blocks: readonly T[],
): { replay: T[]; retained: T[]; orphans: T[] } {
  const operational = blocks.filter((block) => !block.evidence);
  const genesis = operational.filter((block) => block.height === 0);
  if (genesis.length !== 1) {
    return {
      replay: [],
      retained: genesis.length > 1 ? operational.slice() : [],
      orphans: genesis.length === 0 ? operational.slice() : [],
    };
  }
  const anchor = genesis[0]!;
  const rest = continuationAfterAnchor(operational, anchor);
  return {
    replay: [anchor, ...rest.blocks],
    retained: rest.retained,
    orphans: rest.ignored,
  };
}
