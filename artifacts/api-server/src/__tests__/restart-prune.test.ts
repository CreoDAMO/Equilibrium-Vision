/**
 * A pruned prefix is not a reason to delete the suffix the snapshot still names.
 * The walk does not recompute the missing ancestors.
 */
import { describe, expect, it } from "vitest";
import { lineageReachesGenesis, preservedBySnapshotAnchor } from "../chain/restart-boundary.js";

const row = (hash: string, height: number, prevHash: string) => ({ hash, height, prevHash });

describe("a pruned ancestor does not condemn the snapshot suffix", () => {
  it("keeps the surviving walk and the descendants, and not a disconnected row", () => {
    const blocks = [
      row("g", 0, "absent"),
      row("c", 3, "missing"),
      row("d", 4, "c"),
      row("e", 5, "d"),
      row("z", 9, "nowhere"),
    ];
    const reached = lineageReachesGenesis(blocks, blocks[3]!);
    expect(reached.complete).toBe(false);
    if (reached.complete) return;
    expect(reached.reason).toBe("missing-parent");
    expect(reached.chain.map((block) => block.hash)).toEqual(["c", "d", "e"]);

    const kept = preservedBySnapshotAnchor(blocks, "e");
    expect([...kept].sort()).toEqual(["c", "d", "e"]);
    expect(kept.has("z")).toBe(false);
    expect(kept.has("g")).toBe(false);
  });

  it("keeps a fork under the anchor and drops a row that never touches it", () => {
    const blocks = [
      row("a", 2, "missing"),
      row("b", 3, "a"),
      row("c", 3, "a"),
      row("d", 4, "b"),
      row("z", 4, "other"),
    ];
    const kept = preservedBySnapshotAnchor(blocks, "a");
    expect(kept.has("a")).toBe(true);
    expect(kept.has("b")).toBe(true);
    expect(kept.has("c")).toBe(true);
    expect(kept.has("d")).toBe(true);
    expect(kept.has("z")).toBe(false);
  });

  it("preserves nothing when the anchor row is gone", () => {
    expect(preservedBySnapshotAnchor([row("g", 0, "x")], "missing").size).toBe(0);
  });
});
