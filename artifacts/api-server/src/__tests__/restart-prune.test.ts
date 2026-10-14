/**
 * A pruned prefix is not a reason to delete the suffix the snapshot still names.
 * The walk does not recompute the missing ancestors.
 */
import { describe, expect, it } from "vitest";
import { ChainState, importedOmegaContradictsHeader } from "../chain/state.js";
import { stateRootOf } from "../../../../site/src/protocol/constitution.js";
import {
  lineageReachesGenesis,
  operationalReplaySet,
  preservedBySnapshotAnchor,
  recoveryVerdict,
  rowsReturnedAfterOrphanCleanup,
  snapshotContradictsAnchor,
} from "../chain/restart-boundary.js";
import { loadFailureIsUnreachable } from "../chain/persistence.js";

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

describe("a snapshot root that is not the anchor header is not that block", () => {
  const header = "ab".repeat(32);

  it("contradicts a different 64-hex root", () => {
    expect(snapshotContradictsAnchor("cd".repeat(32), header)).toBe(true);
  });

  it("does not contradict the header's own root", () => {
    expect(snapshotContradictsAnchor(header, header)).toBe(false);
  });

  it("does not invent a contradiction when the header has no state root", () => {
    expect(snapshotContradictsAnchor("cd".repeat(32), undefined)).toBe(false);
    expect(snapshotContradictsAnchor("", "")).toBe(false);
  });

  it("contradicts an empty snapshot root when the header committed one", () => {
    expect(snapshotContradictsAnchor("", header)).toBe(true);
  });
});

describe("a preserved orphan is returned, and a row the snapshot does not name is not", () => {
  it("loads the suffix and drops the disconnected row", () => {
    const genesis = { hash: "g", height: 0, prevHash: "" };
    const suffix = { hash: "e", height: 5, prevHash: "missing" };
    const junk = { hash: "z", height: 9, prevHash: "nowhere" };
    const selected = operationalReplaySet([genesis, suffix, junk]);
    expect(selected.replay.map((row) => row.hash)).toEqual(["g"]);
    expect(selected.orphans.map((row) => row.hash).sort()).toEqual(["e", "z"]);
    const preserved = preservedBySnapshotAnchor([genesis, suffix, junk], "e");
    const rows = rowsReturnedAfterOrphanCleanup(selected, preserved);
    expect(rows.load.map((row) => row.hash)).toEqual(["g", "e"]);
    expect(rows.drop.map((row) => row.hash)).toEqual(["z"]);
    expect(rows.load.some((row) => row.hash === "e" && selected.replay.some((replay) => replay.hash === "e"))).toBe(false);
  });
});

describe("a failed load is not an empty chain", () => {
  it("starts fresh only when nothing is configured or the table is empty", () => {
    expect(recoveryVerdict({
      configured: false, queryFailed: false, operationalRows: 0, evidenceRows: 0, replay: 0, retained: 0,
    }).verdict).toBe("fresh");
    expect(recoveryVerdict({
      configured: true, queryFailed: false, operationalRows: 0, evidenceRows: 0, replay: 0, retained: 0,
    }).verdict).toBe("fresh");
  });

  it("restores one chain and refuses a query failure, two genesis rows, or a fork", () => {
    expect(recoveryVerdict({
      configured: true, queryFailed: false, operationalRows: 2, evidenceRows: 0, replay: 2, retained: 0,
    }).verdict).toBe("restored");
    expect(recoveryVerdict({
      configured: true, queryFailed: true, operationalRows: 0, evidenceRows: 0, replay: 0, retained: 0,
    }).verdict).toBe("refused");
    expect(recoveryVerdict({
      configured: true, queryFailed: false, operationalRows: 2, evidenceRows: 0, replay: 0, retained: 2,
    }).reason).toMatch(/no unique height-0/);
    expect(recoveryVerdict({
      configured: true, queryFailed: false, operationalRows: 3, evidenceRows: 0, replay: 1, retained: 2,
    }).reason).toMatch(/truncated/);
  });

  it("treats connection refusal as unreachable and a column error as a load failure", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(loadFailureIsUnreachable(refused)).toBe(true);
    expect(loadFailureIsUnreachable(new Error('column "committed_pressure" does not exist'))).toBe(false);
  });
});

describe("imported Ω must hash to the header that names it", () => {
  it("accepts the record that stateRootOf commits and refuses a torn ledger", () => {
    const state = new ChainState();
    const record = state.exportRestartSnapshot().omega;
    const root = stateRootOf(state.canonicalBody.omega);
    expect(importedOmegaContradictsHeader(record, root)).toBe(false);
    const torn = {
      ...record,
      ledger: record.ledger.map((row) => ({ ...row, balance: row.balance + 1 })),
    };
    if (torn.ledger.length === record.ledger.length && record.ledger.length === 0) {
      torn.ledger = [{ address: "ab".repeat(20), balance: 1, nonce: 0 }];
    }
    expect(importedOmegaContradictsHeader(torn, root)).toBe(true);
    expect(stateRootOf(state.canonicalBody.omega)).toBe(root);
  });

  it("does not invent a payload check when the record or the header root is absent", () => {
    const state = new ChainState();
    const record = state.exportRestartSnapshot().omega;
    const root = stateRootOf(state.canonicalBody.omega);
    expect(importedOmegaContradictsHeader(undefined, root)).toBe(false);
    expect(importedOmegaContradictsHeader(record, undefined)).toBe(false);
    expect(importedOmegaContradictsHeader(record, "not-a-root")).toBe(false);
  });

  it("treats a record that cannot be rebuilt as a contradiction", () => {
    const state = new ChainState();
    const root = stateRootOf(state.canonicalBody.omega);
    expect(importedOmegaContradictsHeader({} as ReturnType<ChainState["exportRestartSnapshot"]>["omega"], root)).toBe(true);
  });
});
