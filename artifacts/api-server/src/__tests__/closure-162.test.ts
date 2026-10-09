/**
 * Restart anchor, prune coverage, WASM trap rollback, and the governance
 * boundary. These do not start the chain.
 */
import { describe, it, expect, afterEach } from "vitest";
import { WasmVM } from "../chain/wasm.js";
import {
  selectSnapshotAnchor,
  chainThroughAnchor,
  evidenceToReplay,
  snapshotCoversPrune,
} from "../chain/restart-boundary.js";
import {
  noteIgnoredGovernanceParams,
  drainPendingParamUpdates,
} from "../chain/governanceContract.js";
import { DEFAULT_PARAMS, GovernanceModule, type Proposal } from "../chain/governance.js";

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
    // The nested call already handed its record to persist. That is not cancelled.
    expect(persisted).toEqual([child.address]);
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
