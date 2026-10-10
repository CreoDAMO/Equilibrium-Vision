/**
 * Restart anchor, prune coverage, WASM trap rollback, and the governance
 * boundary. These do not start the chain.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WasmVM } from "../chain/wasm.js";
import { ChainState, buildGenesisChainFromDoc } from "../chain/state.js";
import {
  selectSnapshotAnchor,
  chainThroughAnchor,
  continuationAfterAnchor,
  operationalReplaySet,
  evidenceToReplay,
  snapshotCoversPrune,
  lineageReachesGenesis,
} from "../chain/restart-boundary.js";
import {
  noteIgnoredGovernanceParams,
  drainPendingParamUpdates,
} from "../chain/governanceContract.js";
import { DEFAULT_PARAMS, GovernanceModule, type Proposal } from "../chain/governance.js";
import { ReplaySet } from "../lib/submission-guard.js";
import { persistBlock } from "../chain/persistence.js";
import { getVerifiedStateRoot, rebuildStateSmt } from "../chain/state-root.js";
import { stateRootOf } from "../../../../site/src/protocol/constitution.js";
import { kernelParty, KERNEL_ALLOCATIONS } from "../chain/kernel-genesis.js";
import type { BlockRecord } from "../chain/types.js";

type Row = { hash: string; height: number; prevHash: string; evidence?: unknown };

const genesis: Row = { hash: "g", height: 0, prevHash: "" };
const operational: Row = { hash: "op", height: 5, prevHash: "g" };
const evidenceSibling: Row = { hash: "ev", height: 5, prevHash: "g", evidence: { kind: "body" } };
const later: Row = { hash: "n", height: 6, prevHash: "op" };
const laterEvidence: Row = { hash: "e6", height: 6, prevHash: "op", evidence: { kind: "body" } };
const tiedLow: Row = { hash: "a-tie", height: 7, prevHash: "n", evidence: { kind: "body" } };
const tiedHigh: Row = { hash: "b-tie", height: 7, prevHash: "n", evidence: { kind: "body" } };

async function compile(name: string, wat: string): Promise<string> {
  const wabtModule = await import("wabt");
  const wabt = await wabtModule.default();
  const mod = wabt.parseWat(name, wat);
  mod.resolveNames();
  mod.validate();
  const { buffer } = mod.toBinary({});
  return Buffer.from(buffer).toString("hex");
}

describe("a canonical skip is not execution", () => {
  const miner = "ab".repeat(20);
  const block = {
    hash: "11".repeat(32),
    height: 0,
    prevHash: "1".repeat(64),
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: 0,
    difficulty: 1_000_000,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 50_000_000,
    miner,
    txCount: 0,
    transactions: [],
    finalized: false,
  };

  it("refuses a wrong parent without appending it or paying the coinbase", () => {
    const state = new ChainState();
    const height = state.canonicalBody.omega.height;
    expect(() => state.addBlock({ ...block })).toThrow(/block is not the successor/);
    expect(state.blocks).toHaveLength(0);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.canonicalBody.omega.height).toBe(height);
  });

  it("can record that block without paying it", () => {
    const state = new ChainState();
    const recorded = { ...block, coinbaseReward: 100 };
    state.recordUnexecuted(recorded);
    expect(state.blocks).toHaveLength(0);
    expect(state.retainedBlocks).toHaveLength(1);
    expect(state.latestBlock).toBeUndefined();
    expect(recorded.canonicalSuccessor).toBe(false);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.canonicalBody.omega.height).toBe(-1);
  });
});

describe("snapshot anchor is the block hash", () => {
  const rows = [evidenceSibling, operational, genesis, later, laterEvidence, tiedHigh, tiedLow];

  it("does not accept the first row at the snapshot height", () => {
    const firstAtHeight = rows.find((row) => row.height === 5);
    expect(firstAtHeight?.hash).toBe("ev");
    const anchor = selectSnapshotAnchor(rows, { height: 5, blockHash: "op" });
    expect(anchor).toEqual({ ok: true, block: operational });
  });

  it("refuses a hash whose height is not the snapshot height", () => {
    expect(selectSnapshotAnchor(rows, { height: 4, blockHash: "op" })).toEqual({
      ok: false,
      reason: "height-mismatch",
    });
  });

  it("refuses a snapshot whose hash is not in the table", () => {
    expect(selectSnapshotAnchor(rows, { height: 5, blockHash: "missing" })).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("installs the parent walk and not the same-height sibling", () => {
    const anchor = selectSnapshotAnchor(rows, { height: 5, blockHash: "op" });
    expect(anchor.ok).toBe(true);
    if (!anchor.ok) return;
    const chain = chainThroughAnchor(rows, anchor.block);
    expect(chain.map((row) => row.hash)).toEqual(["g", "op"]);
  });

  it("keeps an evidence parent that the anchor actually extends", () => {
    const child: Row = { hash: "child", height: 6, prevHash: "ev" };
    const chain = chainThroughAnchor([genesis, evidenceSibling, operational, child], child);
    expect(chain.map((row) => row.hash)).toEqual(["g", "ev", "child"]);
  });
});

describe("evidence replay stops at the snapshot", () => {
  const rows = [evidenceSibling, operational, laterEvidence, tiedHigh, tiedLow, later];

  it("drops evidence at or below the snapshot and orders a height tie by hash", () => {
    expect(evidenceToReplay(rows, 5).map((row) => row.hash)).toEqual(["e6", "a-tie", "b-tie"]);
  });

  it("replays every evidence row when there is no snapshot", () => {
    expect(evidenceToReplay(rows, null).map((row) => row.hash)).toEqual(["ev", "e6", "a-tie", "b-tie"]);
  });
});

describe("prune keeps the snapshot's own row", () => {
  const tip = { tipHeight: 100, keepBlocks: 10 };

  it("refuses the row the delete would remove", () => {
    const decision = snapshotCoversPrune({
      ...tip,
      snapshot: { height: 89, blockHash: "anchor" },
      anchor: { hash: "anchor", height: 89 },
    });
    expect(decision.pruneBelow).toBe(90);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("snapshot anchor would be deleted");
  });

  it("allows the first height the delete keeps, and height zero", () => {
    expect(snapshotCoversPrune({
      ...tip,
      snapshot: { height: 90, blockHash: "anchor" },
      anchor: { hash: "anchor", height: 90 },
    }).allowed).toBe(true);
    expect(snapshotCoversPrune({
      ...tip,
      snapshot: { height: 0, blockHash: "g" },
      anchor: { hash: "g", height: 0 },
    }).allowed).toBe(true);
  });

  it("refuses a hash or height that is not the snapshot", () => {
    expect(snapshotCoversPrune({
      ...tip,
      snapshot: { height: 90, blockHash: "anchor" },
      anchor: { hash: "other", height: 90 },
    }).reason).toBe("snapshot anchor does not match the block row");
    expect(snapshotCoversPrune({
      ...tip,
      snapshot: null,
      anchor: null,
    }).reason).toBe("snapshot anchor missing");
  });

  it("does not treat an empty range as a coverage failure", () => {
    const decision = snapshotCoversPrune({
      tipHeight: 5,
      keepBlocks: 10,
      snapshot: null,
      anchor: null,
    });
    expect(decision.pruneBelow).toBeLessThanOrEqual(0);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("nothing to prune");
  });
});

describe("a trapping call does not keep the storage it wrote", () => {
  const deployer = "aa".repeat(20);

  it("restores the pre-call storage and does not persist the trap", async () => {
    const hex = await compile("trap.wat", `(module
      (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "k")
      (data (i32.const 16) "trap")
      (func (export "call") (param i32) (param i32) (param i32) (result i32)
        (call $storage_set (i32.const 0) (i32.const 1) (i32.const 16) (i32.const 4))
        unreachable)
    )`);
    const vm = new WasmVM();
    const deployed = await vm.deploy(deployer, hex);
    expect(deployed.error).toBeUndefined();
    const record = vm.getContract(deployed.address)!;
    record.storage["k"] = "before";
    record.storage["other"] = "stay";
    const persisted: string[] = [];
    vm.setPersistCallback(async (contract) => { persisted.push(contract.address); });

    const result = await vm.call(deployed.address, 0, []);
    expect(result.success).toBe(false);
    expect(vm.getStorage(deployed.address)).toEqual({ k: "before", other: "stay" });
    expect(persisted).toEqual([]);
  });

  it("keeps a write when the contract returns a negative value", async () => {
    const hex = await compile("neg.wat", `(module
      (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "k")
      (data (i32.const 16) "kept")
      (func (export "call") (param i32) (param i32) (param i32) (result i32)
        (call $storage_set (i32.const 0) (i32.const 1) (i32.const 16) (i32.const 4))
        (i32.const -1))
    )`);
    const vm = new WasmVM();
    const deployed = await vm.deploy(deployer, hex);
    expect(deployed.error).toBeUndefined();
    vm.getContract(deployed.address)!.storage["k"] = "before";
    const persisted: string[] = [];
    vm.setPersistCallback(async (contract) => { persisted.push(contract.address); });

    const result = await vm.call(deployed.address, 0, []);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(-1);
    expect(vm.getStorage(deployed.address)["k"]).toBe("kept");
    expect(persisted).toEqual([deployed.address]);
  });

  it("rolls back a nested write in memory after the parent traps", async () => {
    const childHex = await compile("child.wat", `(module
      (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "k")
      (data (i32.const 16) "child")
      (func (export "call") (param i32) (param i32) (param i32) (result i32)
        (call $storage_set (i32.const 0) (i32.const 1) (i32.const 16) (i32.const 5))
        (i32.const 1))
    )`);
    const vm = new WasmVM();
    const child = await vm.deploy(deployer, childHex);
    expect(child.error).toBeUndefined();
    const parentHex = await compile("parent.wat", `(module
      (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
      (import "env" "call_contract" (func $call_contract (param i32 i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "${child.address}")
      (data (i32.const 48) "p")
      (data (i32.const 64) "parent")
      (func (export "call") (param i32) (param i32) (param i32) (result i32)
        (drop (call $call_contract (i32.const 0) (i32.const 40) (i32.const 0) (i32.const 0) (i32.const 0)))
        (call $storage_set (i32.const 48) (i32.const 1) (i32.const 64) (i32.const 6))
        unreachable)
    )`);
    const parent = await vm.deploy(deployer, parentHex);
    expect(parent.error).toBeUndefined();
    vm.getContract(child.address)!.storage["k"] = "before-child";
    vm.getContract(parent.address)!.storage["p"] = "before-parent";
    const persisted: string[] = [];
    vm.setPersistCallback(async (contract) => { persisted.push(contract.address); });

    const result = await vm.call(parent.address, 0, []);
    expect(result.success).toBe(false);
    expect(vm.getStorage(child.address)["k"]).toBe("before-child");
    expect(vm.getStorage(parent.address)["p"]).toBe("before-parent");
    expect(persisted).toEqual([]);
  });

  it("does not commit a nested write when the batch commit fails", async () => {
    const hex = await compile("keep.wat", `(module
      (import "env" "storage_set" (func $storage_set (param i32 i32 i32 i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "k")
      (data (i32.const 16) "kept")
      (func (export "call") (param i32) (param i32) (param i32) (result i32)
        (call $storage_set (i32.const 0) (i32.const 1) (i32.const 16) (i32.const 4))
        (i32.const 1))
    )`);
    const vm = new WasmVM();
    const deployed = await vm.deploy("aa".repeat(20), hex);
    expect(deployed.error).toBeUndefined();
    vm.getContract(deployed.address)!.storage["k"] = "before";
    vm.setCommitCallback(async () => false);
    const result = await vm.call(deployed.address, 0, []);
    expect(result.success).toBe(false);
    expect(result.error).toBe("contract persist did not commit");
    expect(vm.getStorage(deployed.address)["k"]).toBe("before");
  });
});

describe("pending governance keys are not a second writer", () => {
  const previous = process.env["GOVERNANCE_CONTRACT_ADDRESS"];
  afterEach(() => {
    if (previous === undefined) delete process.env["GOVERNANCE_CONTRACT_ADDRESS"];
    else process.env["GOVERNANCE_CONTRACT_ADDRESS"] = previous;
  });

  it("leaves the key in storage and does not log the same value twice", () => {
    const address = "ab".repeat(20);
    const vm = new WasmVM();
    vm.loadContracts([{
      address,
      deployer: "cd".repeat(20),
      bytecode: "00",
      bytecodeHash: "00",
      storage: { "gov_pending_param:baseReward": "999", keep: "yes" },
      deployedAt: 0,
      callCount: 0,
      totalGasUsed: 0,
    }]);
    process.env["GOVERNANCE_CONTRACT_ADDRESS"] = address;
    const noted = new Map<string, number>();
    const logs: string[] = [];
    noteIgnoredGovernanceParams(vm, noted, (name, value) => logs.push(`${name}=${value}`));
    noteIgnoredGovernanceParams(vm, noted, (name, value) => logs.push(`${name}=${value}`));

    expect(vm.getStorage(address)["gov_pending_param:baseReward"]).toBe("999");
    expect(vm.getStorage(address)["keep"]).toBe("yes");
    expect(logs).toEqual(["baseReward=999"]);

    const gov = new GovernanceModule();
    const params = gov.params as unknown as Record<string, number>;
    const read = Object.prototype.hasOwnProperty.call(params, "baseReward") ? params["baseReward"] : undefined;
    expect(read).toBe(DEFAULT_PARAMS.baseReward);
  });

  it("does not write ChainParameters when a passed proposal is executed", () => {
    let applied = false;
    const gov = new GovernanceModule(() => { applied = true; });
    const proposal: Proposal = {
      id: "p",
      type: "parameter_change",
      title: "raise",
      description: "",
      proposer: "aa",
      parameterChange: { key: "baseReward", value: 1 },
      submittedAt: 1,
      votingEndsAt: 2,
      readyToExecuteAt: 10,
      votesYes: 1,
      votesNo: 0,
      votesAbstain: 0,
      votes: new Map(),
      status: "passed",
    };
    gov.proposals.set(proposal.id, proposal);
    gov.processBlock(10, 1);
    expect(gov.params.baseReward).toBe(DEFAULT_PARAMS.baseReward);
    expect(applied).toBe(false);
    expect(gov.getProposal("p")?.status).toBe("executed");
  });

  it("still deletes only when the explicit drain is called", () => {
    const address = "ef".repeat(20);
    const vm = new WasmVM();
    vm.loadContracts([{
      address,
      deployer: "cd".repeat(20),
      bytecode: "00",
      bytecodeHash: "00",
      storage: { "gov_pending_param:baseReward": "999" },
      deployedAt: 0,
      callCount: 0,
      totalGasUsed: 0,
    }]);
    process.env["GOVERNANCE_CONTRACT_ADDRESS"] = address;
    expect(drainPendingParamUpdates(vm)).toEqual({ baseReward: 999 });
    expect(vm.getStorage(address)["gov_pending_param:baseReward"]).toBeUndefined();
  });
});

describe("snapshot replay follows the anchor, not the height", () => {
  const genesis = { hash: "g", height: 0, prevHash: "" };
  const anchor = { hash: "a", height: 5, prevHash: "g" };
  const descendant = { hash: "b", height: 6, prevHash: "a" };
  const unrelated = { hash: "x", height: 6, prevHash: "other" };
  const sibling = { hash: "s", height: 6, prevHash: "a" };

  it("does not admit an unrelated row because its height is past the snapshot", () => {
    const forward = continuationAfterAnchor([genesis, anchor, descendant, unrelated], anchor);
    const reverse = continuationAfterAnchor([unrelated, descendant, anchor, genesis], anchor);
    expect(forward.fork).toBeNull();
    expect(forward.blocks.map((row) => row.hash)).toEqual(["b"]);
    expect(reverse.blocks.map((row) => row.hash)).toEqual(["b"]);
    expect(new Set(forward.ignored.map((row) => row.hash))).toEqual(new Set(["g", "x"]));
    expect(new Set(reverse.ignored.map((row) => row.hash))).toEqual(new Set(["g", "x"]));
    expect(forward.retained).toEqual([]);
  });

  it("does not choose a same-height sibling by hash order", () => {
    const lowFirst = continuationAfterAnchor([anchor, descendant, sibling], anchor);
    const highFirst = continuationAfterAnchor([anchor, sibling, descendant], anchor);
    expect(lowFirst.blocks).toEqual([]);
    expect(highFirst.blocks).toEqual([]);
    expect(new Set(lowFirst.fork?.children)).toEqual(new Set(["b", "s"]));
    expect(new Set(highFirst.fork?.children)).toEqual(new Set(["b", "s"]));
    expect(new Set(lowFirst.retained.map((row) => row.hash))).toEqual(new Set(["b", "s"]));
    expect(new Set(highFirst.retained.map((row) => row.hash))).toEqual(new Set(["b", "s"]));
  });

  it("keeps a unique prefix and retains the fork, including a later child of one sibling", () => {
    const child = { hash: "c", height: 7, prevHash: "b" };
    const earlyX = { hash: "x", height: 7, prevHash: "s", timestamp: 1 };
    const rows = [genesis, anchor, descendant, sibling, child, earlyX];
    const selected = operationalReplaySet(rows);
    const reversed = operationalReplaySet([...rows].reverse());
    expect(selected.replay.map((row) => row.hash)).toEqual(["g", "a"]);
    expect(reversed.replay.map((row) => row.hash)).toEqual(["g", "a"]);
    expect(new Set(selected.retained.map((row) => row.hash))).toEqual(new Set(["b", "s", "c", "x"]));
    expect(new Set(reversed.retained.map((row) => row.hash))).toEqual(new Set(["b", "s", "c", "x"]));
    expect(selected.orphans).toEqual([]);
  });

  it("treats a disconnected row as an orphan and does not let it join the replay", () => {
    const orphan = { hash: "z", height: 9, prevHash: "missing" };
    const selected = operationalReplaySet([genesis, anchor, descendant, orphan]);
    expect(selected.replay.map((row) => row.hash)).toEqual(["g", "a", "b"]);
    expect(selected.orphans.map((row) => row.hash)).toEqual(["z"]);
    expect(selected.retained).toEqual([]);
  });
});

describe("a retained record is not canonical authority", () => {
  const miner = "ab".repeat(20);
  const decoy = {
    hash: "ab".repeat(32),
    height: 4,
    prevHash: "1".repeat(64),
    merkleRoot: "0".repeat(64),
    timestamp: 9_000_000_000,
    nonce: 0,
    difficulty: 1_000_000,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 100,
    miner,
    txCount: 0,
    transactions: [],
    finalized: false,
  };

  it("does not set the tip, the height, or the producer parent", () => {
    const state = new ChainState();
    const omegaHeight = state.canonicalBody.omega.height;
    state.recordUnexecuted({ ...decoy });
    expect(state.blocks).toHaveLength(0);
    expect(state.height).toBe(-1);
    expect(state.latestBlock).toBeUndefined();
    expect(state.canonicalTip).toBeUndefined();
    expect(state.retainedBlocks).toHaveLength(1);
    expect(state.retainedBlocks[0]?.canonicalSuccessor).toBe(false);
    expect(state.canonicalWork().prevHash).toBe(state.canonicalBody.omega.tipHash);
    expect(state.canonicalWork().prevHash).not.toBe(decoy.hash);
    expect(state.canonicalWork().height).toBe(omegaHeight + 1);
    expect(state.ledger.balance(miner)).toBe(0);
  });

  it("does not let that record's timestamp refuse a later candidate before Ω does", () => {
    const state = new ChainState();
    state.recordUnexecuted({ ...decoy });
    expect(() => state.addBlock({
      ...decoy,
      hash: "11".repeat(32),
      height: 0,
      timestamp: 1_700_000_000,
    })).toThrow(/block is not the successor/);
    expect(state.blocks).toHaveLength(0);
    expect(state.canonicalBody.omega.height).toBe(-1);
    expect(state.ledger.balance(miner)).toBe(0);
    expect(state.retainedBlocks).toHaveLength(1);
  });
});

describe("a snapshot walk that misses genesis is not a lineage", () => {
  it("treats a height-0 block as complete even when its parent is absent", () => {
    const genesis = { hash: "g", height: 0, prevHash: "not-in-table" };
    const child = { hash: "c", height: 1, prevHash: "g" };
    const reached = lineageReachesGenesis([child, genesis], child);
    expect(reached.complete).toBe(true);
    if (!reached.complete) return;
    expect(reached.chain.map((row) => row.hash)).toEqual(["g", "c"]);
    expect(chainThroughAnchor([child, genesis], child).map((row) => row.hash)).toEqual(["g", "c"]);
  });

  it("refuses a missing parent before height 0", () => {
    const tip = { hash: "t", height: 4, prevHash: "missing" };
    const reached = lineageReachesGenesis([tip], tip);
    expect(reached.complete).toBe(false);
    if (reached.complete) return;
    expect(reached.reason).toBe("missing-parent");
    expect(chainThroughAnchor([tip], tip).map((row) => row.hash)).toEqual(["t"]);
  });

  it("refuses a cycle that never reaches height 0", () => {
    const a = { hash: "a", height: 2, prevHash: "b" };
    const b = { hash: "b", height: 1, prevHash: "a" };
    const reached = lineageReachesGenesis([a, b], a);
    expect(reached.complete).toBe(false);
    if (reached.complete) return;
    expect(reached.reason).toBe("cycle");
  });
});

describe("a refused submission does not keep its replay key", () => {
  it("forgets a key so the same candidate can be submitted again", () => {
    const seen = new ReplaySet(4);
    expect(seen.tryAdd("tip:1")).toBe(true);
    expect(seen.tryAdd("tip:1")).toBe(false);
    seen.forget("tip:1");
    expect(seen.tryAdd("tip:1")).toBe(true);
    expect(seen.size).toBe(1);
  });
});

describe("persistBlock reports whether the write happened", () => {
  it("returns false instead of throwing when the configured database does not commit", async () => {
    const block: BlockRecord = {
      hash: "ab".repeat(32),
      height: 0,
      prevHash: "0".repeat(64),
      merkleRoot: "0".repeat(64),
      timestamp: 1,
      nonce: 0,
      difficulty: 1,
      residual: 0,
      recursionDepth: 2,
      coinbaseReward: 0,
      miner: "ab".repeat(20),
      txCount: 0,
      transactions: [],
    };
    const saved = await persistBlock(block);
    expect(saved.durable).toBe(false);
    expect(saved.outcome).toBe("failed");
  });
});

describe("the header root is not the operational SMT", () => {
  it("accepts a successor when stateRootOf matches the header and does not require the SMT to match", () => {
    const state = buildGenesisChainFromDoc({
      chain_id: "equilibrium-1",
      timestamp: "2026-07-05T00:44:37.417Z",
      initial_supply: "100000000",
      allocations: KERNEL_ALLOCATIONS.map((line) => ({
        address: line.address,
        amount: String(line.amount),
        vesting: "none",
        category: "line",
      })),
      initial_validators: [],
      dex_pools: [],
      parameters: {
        target_block_time_ms: 15_000,
        residual_threshold: 8e-4,
        initial_difficulty: 1_000_000,
        slashing_double_sign_pct: 5,
        slashing_downtime_pct: 1,
        unbonding_period_blocks: 10,
        max_validators: 100,
        governance_quorum_pct: 67,
        governance_voting_period_blocks: 10,
      },
    });
    const omega = state.canonicalBody.omega;
    const miner = kernelParty("mainnet").miner;
    state.addBlock({
      hash: "11".repeat(32),
      height: omega.height + 1,
      prevHash: omega.tipHash,
      merkleRoot: "0".repeat(64),
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: omega.difficulty,
      residual: 1e-9,
      recursionDepth: 2,
      coinbaseReward: 0,
      miner,
      txCount: 0,
      transactions: [],
      committedPressure: 0,
    });
    const tip = state.canonicalTip;
    expect(tip?.stateRoot).toBe(stateRootOf(state.canonicalBody.omega));
    const verified = getVerifiedStateRoot(state);
    expect(verified.error).toBeUndefined();
    expect(verified.snapshot?.protocolStateRoot).toBe(tip?.stateRoot);
    expect(verified.snapshot?.operationalRoot).toBe(rebuildStateSmt(state).root());
    expect(verified.snapshot?.operationalRoot).not.toBe(verified.snapshot?.protocolStateRoot);

    tip!.stateRoot = "ab".repeat(32);
    const refused = getVerifiedStateRoot(state);
    expect(refused.snapshot).toBeUndefined();
    expect(refused.error?.status).toBe(409);
    expect(refused.error?.message).toMatch(/Protocol state root mismatch/);
  });
});

describe("a block is not announced before it is persisted", () => {
  const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("waits for the HTTP persist result before 201", () => {
    const src = source("../routes/blocks.ts");
    const commit = src.indexOf("commitOperational(block");
    const created = src.indexOf("res.status(201)", commit);
    expect(commit).toBeGreaterThan(0);
    expect(created).toBeGreaterThan(commit);
    expect(src.includes("outcome.kept")).toBe(true);
    expect(src.indexOf("submitReplay.forget(replayKey)")).toBeGreaterThan(0);
  });

  it("waits for the Stratum persist result before accepting the share", () => {
    const src = source("../lib/stratum-server.ts");
    const commit = src.indexOf("commitOperational(block");
    const accepted = src.indexOf("this.respond(session.socket, req.id, true, null)", commit);
    expect(commit).toBeGreaterThan(0);
    expect(accepted).toBeGreaterThan(commit);
    expect(src.includes("recentShares.forget(shareKey)")).toBe(true);
  });

  it("logs peer acceptance only after the block is the successor and the write returned", () => {
    const src = source("../index.ts");
    const accept = src.indexOf("P2P sync: accepting block from peer");
    const commit = src.lastIndexOf("commitOperational", accept);
    expect(commit).toBeGreaterThan(0);
    expect(accept).toBeGreaterThan(commit);
    expect(src.includes("outcome.kept")).toBe(true);
  });

  it("does not gossip a mined block from the async miner before the cycle persists it", () => {
    const src = source("../chain/state.ts");
    const asyncFn = src.slice(src.indexOf("export async function mineNextBlockAsync"));
    const body = asyncFn.slice(0, asyncFn.indexOf("export function mineNextBlock("));
    expect(body.includes("gossipBlock")).toBe(false);
    expect(body.includes("addBlock")).toBe(false);
    const cycleSrc = source("../chain/index.ts");
    const cycleAt = cycleSrc.indexOf("async function runMiningCycle");
    const cycle = cycleSrc.slice(cycleAt, cycleSrc.indexOf("export function startMining"));
    const commit = cycle.indexOf("commitOperational");
    const gossip = cycle.indexOf("chainState.gossipBlock(block.hash)");
    expect(commit).toBeGreaterThan(0);
    expect(gossip).toBeGreaterThan(commit);
  });
});
