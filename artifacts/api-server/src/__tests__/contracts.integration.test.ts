/**
 * Smart contract tests — WasmVM unit tests + contracts API integration tests.
 *
 * Uses pre-compiled WASM bytecode (counter + adder) so the test suite has
 * zero build-time toolchain dependencies.
 *
 * WasmVM unit tests exercise the class in isolation (fresh instance per
 * suite).  API integration tests go through the Express app after initChain().
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import supertest from "supertest";
import { WasmVM, type ContractRecord } from "../chain/wasm.js";
import app from "../app.js";
import { initChain, stopMining } from "../chain/index.js";

const api = supertest(app);

// ── Pre-compiled WASM bytecode ────────────────────────────────────────────────
// Compiled from COUNTER_CONTRACT_WAT / ADDER_CONTRACT_WAT in wasm.ts.
// Re-generate with: wabt.parseWat("x.wat", src).toBinary({}).buffer

const COUNTER_HEX =
  "0061736d0100000001080160037f7f7f017f0302010005030100010606017f0141000b" +
  "071102066d656d6f727902000463616c6c00000a1501130020004101460440230041016a" +
  "24000b23000b";

const ADDER_HEX =
  "0061736d0100000001080160037f7f7f017f03020100050301000107110206" +
  "6d656d6f727902000463616c6c00000a1d011b00200041014604402001280200" +
  "200141046a2802006a0f0b41000b";

const INVALID_HEX = "deadbeef01020304"; // not a WASM binary

// Storage contract — method 1: storage_set("k","7"), method 0: storage_get("k") → returns value length
const STORAGE_HEX =
  "0061736d01000000010f0260047f7f7f7f0060037f7f7f017f02250203656e76" +
  "0b73746f726167655f736574000003656e760b73746f726167655f676574000103" +
  "0201010503010001071102066d656d6f727902000463616c6c00020a23012100200041" +
  "014604404100410141c0004101100041010f0b4100410141800110010b0b0e02004100" +
  "0b016b0041c0000b0137";

const COUNTER_ABI = {
  functions: [
    { name: "get",       methodId: 0, inputs: [],           outputs: ["i32"] },
    { name: "increment", methodId: 1, inputs: [],           outputs: ["i32"] },
  ],
};

const ADDER_ABI = {
  functions: [
    { name: "add", methodId: 1, inputs: ["i32", "i32"], outputs: ["i32"] },
  ],
};

const DEPLOYER = "aabbccddee1122334455aabbccddee1122334455";

// shared chain init / teardown
beforeAll(async () => { await initChain(); }, 30_000);
afterAll(() => { stopMining(); });

// ── WasmVM Unit Tests ─────────────────────────────────────────────────────────

describe("WasmVM — deploy()", () => {
  let vm: WasmVM;

  beforeAll(() => {
    vm = new WasmVM();
    vm.setBlockHeight(10);
  });

  it("deploys a valid contract and returns a 40-char hex address", async () => {
    const { address, error } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI);
    expect(error).toBeUndefined();
    expect(address).toMatch(/^[0-9a-f]{40}$/);
  });

  it("stores the contract record after deploy", async () => {
    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI);
    const record = vm.getContract(address)!;
    expect(record).toBeDefined();
    expect(record.deployer).toBe(DEPLOYER);
    expect(record.deployedAt).toBe(10);
    expect(record.callCount).toBe(0);
    expect(record.totalGasUsed).toBe(0);
  });

  it("stores the ABI on the contract record", async () => {
    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI);
    expect(vm.getContract(address)?.abi?.functions).toHaveLength(2);
    expect(vm.getContract(address)?.abi?.functions[0].name).toBe("get");
  });

  it("stores bytecodeHash derived from the bytecode", async () => {
    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    expect(vm.getContract(address)?.bytecodeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two deploys produce distinct addresses", async () => {
    await new Promise(r => setTimeout(r, 2)); // ensure distinct timestamp
    const { address: a1 } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    await new Promise(r => setTimeout(r, 2));
    const { address: a2 } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    expect(a1).not.toBe(a2);
  });

  it("rejects invalid WASM bytecode and returns error", async () => {
    const { address, error } = await vm.deploy(DEPLOYER, INVALID_HEX);
    expect(error).toMatch(/invalid wasm/i);
    expect(address).toBe("");
  });

  it("invalid deploy does not add a record", async () => {
    const before = vm.listContracts().length;
    await vm.deploy(DEPLOYER, INVALID_HEX);
    expect(vm.listContracts().length).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — call()", () => {
  let vm: WasmVM;
  let counterAddr: string;
  let adderAddr: string;

  beforeAll(async () => {
    vm = new WasmVM();
    vm.setBlockHeight(1);
    ({ address: counterAddr } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI));
    ({ address: adderAddr }  = await vm.deploy(DEPLOYER, ADDER_HEX,   ADDER_ABI));
  });

  it("counter methodId=0 returns 0 (initial read)", async () => {
    const result = await vm.call(counterAddr, 0, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(0);
  });

  it("counter methodId=1 returns 1 (single increment)", async () => {
    const result = await vm.call(counterAddr, 1, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(1);
  });

  it("counter returns logs array (possibly empty)", async () => {
    const result = await vm.call(counterAddr, 0, [], 1_000_000);
    expect(result.logs).toBeInstanceOf(Array);
  });

  it("tracks callCount and totalGasUsed after each call", async () => {
    const before = vm.getContract(counterAddr)!;
    const prevCalls = before.callCount;
    const prevGas   = before.totalGasUsed;

    await vm.call(counterAddr, 0, [], 1_000_000);

    const after = vm.getContract(counterAddr)!;
    expect(after.callCount).toBe(prevCalls + 1);
    expect(after.totalGasUsed).toBeGreaterThan(prevGas);
  });

  it("gasUsed is positive after a successful call", async () => {
    const result = await vm.call(counterAddr, 0, [], 1_000_000);
    expect(result.gasUsed).toBeGreaterThan(0);
  });

  it("returns error for an unknown contract address", async () => {
    const result = await vm.call("0".repeat(40), 0, [], 1_000_000);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(result.returnValue).toBeNull();
  });

  it("adder deploys and returns a valid call result", async () => {
    const result = await vm.call(adderAddr, 0, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(typeof result.returnValue).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — listContracts() / getContract() / getStorage()", () => {
  let vm: WasmVM;
  let addr: string;

  beforeAll(async () => {
    vm = new WasmVM();
    vm.setBlockHeight(1);
    ({ address: addr } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI));
  });

  it("listContracts() includes the deployed contract", () => {
    expect(vm.listContracts().some(c => c.address === addr)).toBe(true);
  });

  it("contractCount() reflects deployed count", async () => {
    const before = vm.contractCount();
    await new Promise(r => setTimeout(r, 2));
    await vm.deploy(DEPLOYER, COUNTER_HEX);
    expect(vm.contractCount()).toBe(before + 1);
  });

  it("getContract() returns undefined for an unknown address", () => {
    expect(vm.getContract("0".repeat(40))).toBeUndefined();
  });

  it("getStorage() returns empty object for a fresh contract", () => {
    expect(vm.getStorage(addr)).toEqual({});
  });

  it("getStorage() returns empty object for an unknown address", () => {
    expect(vm.getStorage("0".repeat(40))).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — storage host functions", () => {
  let vm: WasmVM;
  let addr: string;

  beforeAll(async () => {
    vm = new WasmVM();
    vm.setBlockHeight(1);
    ({ address: addr } = await vm.deploy(DEPLOYER, STORAGE_HEX));
  });

  it("method 0 returns 0 when key is unset (empty storage)", async () => {
    const result = await vm.call(addr, 0, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(0); // storage_get returns length=0 for missing key
  });

  it("method 1 writes to storage via storage_set and returns 1", async () => {
    const result = await vm.call(addr, 1, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(1);
  });

  it("storage key 'k' is visible in getStorage() after a set", () => {
    const storage = vm.getStorage(addr);
    expect(storage).toHaveProperty("k");
    expect(storage["k"]).toBe("7");
  });

  it("method 0 returns 1 after set (key length = 1)", async () => {
    // Storage already set by previous test — per-instantiation state is
    // keyed through the host, so getStorage() persists across calls.
    const result = await vm.call(addr, 0, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(1); // length of "7"
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — gas accumulation across calls", () => {
  let vm: WasmVM;
  let addr: string;

  beforeAll(async () => {
    vm = new WasmVM();
    vm.setBlockHeight(1);
    ({ address: addr } = await vm.deploy(DEPLOYER, COUNTER_HEX, COUNTER_ABI));
  });

  it("totalGasUsed accumulates monotonically over multiple calls", async () => {
    const r1 = await vm.call(addr, 0, [], 1_000_000);
    const after1 = vm.getContract(addr)!.totalGasUsed;

    const r2 = await vm.call(addr, 0, [], 1_000_000);
    const after2 = vm.getContract(addr)!.totalGasUsed;

    const r3 = await vm.call(addr, 1, [], 1_000_000);
    const after3 = vm.getContract(addr)!.totalGasUsed;

    expect(after1).toBeGreaterThan(0);
    expect(after2).toBeGreaterThan(after1);
    expect(after3).toBeGreaterThan(after2);

    // Sum of individual gasUsed responses must equal totalGasUsed
    expect(after3).toBe(r1.gasUsed + r2.gasUsed + r3.gasUsed);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — deploy without ABI", () => {
  it("deploys successfully without an ABI argument", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const { address, error } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    expect(error).toBeUndefined();
    expect(address).toMatch(/^[0-9a-f]{40}$/);
  });

  it("contract record has undefined abi when none is provided", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    expect(vm.getContract(address)?.abi).toBeUndefined();
  });

  it("contract without ABI is still callable", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    const result = await vm.call(address, 1, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — loadContracts()", () => {
  it("bulk-loads records and makes them immediately callable", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const record: ContractRecord = {
      address:      "1234567890abcdef1234567890abcdef12345678",
      deployer:     DEPLOYER,
      bytecode:     COUNTER_HEX,
      bytecodeHash: "aaaa",
      storage:      {},
      deployedAt:   5,
      callCount:    0,
      totalGasUsed: 0,
      abi:          COUNTER_ABI,
    };
    vm.loadContracts([record]);
    const loaded = vm.getContract("1234567890abcdef1234567890abcdef12345678");
    expect(loaded).toBeDefined();
    const result = await vm.call("1234567890abcdef1234567890abcdef12345678", 1, [], 1_000_000);
    expect(result.success).toBe(true);
    expect(result.returnValue).toBe(1);
  });

  it("loaded record preserves original deployedAt, callCount, totalGasUsed", () => {
    const vm = new WasmVM();
    const record: ContractRecord = {
      address:      "abcdef1234567890abcdef1234567890abcdef12",
      deployer:     DEPLOYER,
      bytecode:     COUNTER_HEX,
      bytecodeHash: "bbbb",
      storage:      {},
      deployedAt:   42,
      callCount:    7,
      totalGasUsed: 3500,
    };
    vm.loadContracts([record]);
    const loaded = vm.getContract("abcdef1234567890abcdef1234567890abcdef12")!;
    expect(loaded.deployedAt).toBe(42);
    expect(loaded.callCount).toBe(7);
    expect(loaded.totalGasUsed).toBe(3500);
  });

  it("loading multiple records makes all callable", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const make = (addr: string, bytecode: string): ContractRecord => ({
      address: addr, deployer: DEPLOYER, bytecode,
      bytecodeHash: "x", storage: {}, deployedAt: 1, callCount: 0, totalGasUsed: 0,
    });
    vm.loadContracts([
      make("aaaa000000000000000000000000000000000001", COUNTER_HEX),
      make("aaaa000000000000000000000000000000000002", ADDER_HEX),
    ]);
    expect(vm.contractCount()).toBe(2);
    const r1 = await vm.call("aaaa000000000000000000000000000000000001", 0, [], 1_000_000);
    const r2 = await vm.call("aaaa000000000000000000000000000000000002", 0, [], 1_000_000);
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("WasmVM — persist callback", () => {
  it("fires once after a successful deploy", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const onPersist = vi.fn().mockResolvedValue(undefined);
    vm.setPersistCallback(onPersist);

    await vm.deploy(DEPLOYER, COUNTER_HEX);
    await new Promise(r => setTimeout(r, 20)); // flush microtasks

    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist.mock.calls[0]![0]).toMatchObject({ deployer: DEPLOYER });
  });

  it("fires once after a successful call", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    const onPersist = vi.fn().mockResolvedValue(undefined);
    vm.setPersistCallback(onPersist);

    const { address } = await vm.deploy(DEPLOYER, COUNTER_HEX);
    onPersist.mockClear(); // ignore the deploy fire

    await vm.call(address, 1, [], 1_000_000);
    await new Promise(r => setTimeout(r, 20));

    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onPersist.mock.calls[0]![0]).toMatchObject({ address });
  });

  it("does not fire when calling an unknown address", async () => {
    const vm = new WasmVM();
    const onPersist = vi.fn().mockResolvedValue(undefined);
    vm.setPersistCallback(onPersist);

    await vm.call("0".repeat(40), 0, [], 1_000_000);
    await new Promise(r => setTimeout(r, 20));

    expect(onPersist).not.toHaveBeenCalled();
  });

  it("does not throw if the persist callback rejects", async () => {
    const vm = new WasmVM();
    vm.setBlockHeight(1);
    vm.setPersistCallback(() => Promise.reject(new Error("DB down")));

    // deploy fires persist callback — the rejection must be swallowed
    await expect(vm.deploy(DEPLOYER, COUNTER_HEX)).resolves.not.toThrow();
    await new Promise(r => setTimeout(r, 20));
  });
});

// ── Contracts API Integration Tests ──────────────────────────────────────────

describe("GET /api/contracts/examples", () => {
  it("returns 200 with an examples array", async () => {
    const res = await api.get("/api/contracts/examples");
    expect(res.status).toBe(200);
    expect(res.body.examples).toBeInstanceOf(Array);
    expect(res.body.examples.length).toBeGreaterThanOrEqual(2);
  });

  it("each example has name, description, wat, and abi", async () => {
    const res = await api.get("/api/contracts/examples");
    for (const ex of res.body.examples as unknown[]) {
      expect(ex).toHaveProperty("name");
      expect(ex).toHaveProperty("description");
      expect(ex).toHaveProperty("wat");
      expect(ex).toHaveProperty("abi");
    }
  });

  it("counter example WAT starts with (module", async () => {
    const res = await api.get("/api/contracts/examples");
    const counter = (res.body.examples as Array<{ name: string; wat: string }>)
      .find(e => e.name.toLowerCase().includes("counter"));
    expect(counter).toBeDefined();
    expect(counter!.wat.trim()).toMatch(/^\(module/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contracts", () => {
  it("returns 200 with count and contracts array", async () => {
    const res = await api.get("/api/contracts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("count");
    expect(res.body).toHaveProperty("contracts");
    expect(Array.isArray(res.body.contracts)).toBe(true);
  });

  it("count matches contracts array length", async () => {
    const res = await api.get("/api/contracts");
    expect(res.body.count).toBe(res.body.contracts.length);
  });

  it("each contract entry has address, deployer, callCount, totalGasUsed", async () => {
    // Deploy one so the list is non-empty
    await api.post("/api/contracts/deploy").send({ deployer: DEPLOYER, bytecodeHex: COUNTER_HEX });
    const res = await api.get("/api/contracts");
    for (const c of res.body.contracts as unknown[]) {
      expect(c).toHaveProperty("address");
      expect(c).toHaveProperty("deployer");
      expect(c).toHaveProperty("callCount");
      expect(c).toHaveProperty("totalGasUsed");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/contracts/deploy", () => {
  it("deploys a valid contract and returns address + success", async () => {
    const res = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
      abi:         COUNTER_ABI,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.address).toMatch(/^[0-9a-f]{40}$/);
    expect(res.body.deployer).toBe(DEPLOYER);
    expect(res.body.blockHeight).toBeGreaterThanOrEqual(0);
  });

  it("returns 400 when bytecodeHex is absent", async () => {
    const res = await api.post("/api/contracts/deploy").send({ deployer: DEPLOYER });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when deployer is absent", async () => {
    const res = await api.post("/api/contracts/deploy").send({ bytecodeHex: COUNTER_HEX });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 with an error message for invalid WASM", async () => {
    const res = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: INVALID_HEX,
    });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("deployed address appears in GET /api/contracts list", async () => {
    const deployRes = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
    });
    const newAddr = deployRes.body.address as string;
    const listRes = await api.get("/api/contracts");
    const found = (listRes.body.contracts as Array<{ address: string }>)
      .some(c => c.address === newAddr);
    expect(found).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contracts/:address", () => {
  let addr: string;

  beforeAll(async () => {
    const res = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
      abi:         COUNTER_ABI,
    });
    addr = res.body.address;
  });

  it("returns 200 with the correct contract fields", async () => {
    const res = await api.get(`/api/contracts/${addr}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      address:      addr,
      deployer:     DEPLOYER,
      callCount:    expect.any(Number),
      totalGasUsed: expect.any(Number),
      deployedAt:   expect.any(Number),
    });
  });

  it("includes abi with the correct number of functions", async () => {
    const res = await api.get(`/api/contracts/${addr}`);
    expect(res.body.abi?.functions).toHaveLength(2);
    const names = (res.body.abi.functions as Array<{ name: string }>).map(f => f.name);
    expect(names).toContain("get");
    expect(names).toContain("increment");
  });

  it("bytecode field is present and shorter than the raw hex", async () => {
    const res = await api.get(`/api/contracts/${addr}`);
    expect(typeof res.body.bytecode).toBe("string");
    expect(res.body.bytecode.length).toBeGreaterThan(0);
    // The route intentionally truncates; just verify it's not the full hex
    expect(res.body.bytecode.length).toBeLessThan(COUNTER_HEX.length);
  });

  it("returns 404 for an unknown address", async () => {
    const res = await api.get("/api/contracts/" + "0".repeat(40));
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contracts/:address/storage", () => {
  let addr: string;

  beforeAll(async () => {
    const res = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
    });
    addr = res.body.address;
  });

  it("returns 200 with address, storage, and keys count", async () => {
    const res = await api.get(`/api/contracts/${addr}/storage`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ address: addr, keys: 0 });
    expect(res.body.storage).toEqual({});
  });

  it("returns 404 for an unknown address", async () => {
    const res = await api.get("/api/contracts/" + "0".repeat(40) + "/storage");
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/contracts/:address/call", () => {
  let counterAddr: string;

  beforeAll(async () => {
    const res = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
      abi:         COUNTER_ABI,
    });
    counterAddr = res.body.address;
  });

  it("calls methodId=0 successfully and returns 0 (initial state)", async () => {
    const res = await api.post(`/api/contracts/${counterAddr}/call`).send({
      methodId:  0,
      args:      [],
      gasLimit:  1_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.returnValue).toBe(0);
    expect(res.body.gasUsed).toBeGreaterThan(0);
  });

  it("calls methodId=1 and returns 1 (single increment)", async () => {
    const res = await api.post(`/api/contracts/${counterAddr}/call`).send({
      methodId:  1,
      args:      [],
      gasLimit:  1_000_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.returnValue).toBe(1);
  });

  it("response echoes address and methodId", async () => {
    const res = await api.post(`/api/contracts/${counterAddr}/call`).send({
      methodId: 0,
    });
    expect(res.body.address).toBe(counterAddr);
    expect(res.body.methodId).toBe(0);
  });

  it("response includes a logs array", async () => {
    const res = await api.post(`/api/contracts/${counterAddr}/call`).send({
      methodId: 0,
    });
    expect(res.body.logs).toBeInstanceOf(Array);
  });

  it("returns 400 with success:false for an unknown address", async () => {
    const res = await api.post("/api/contracts/" + "0".repeat(40) + "/call").send({
      methodId: 0,
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body).toHaveProperty("error");
  });

  it("callCount increments after each call (visible via GET)", async () => {
    const before = (await api.get(`/api/contracts/${counterAddr}`)).body.callCount as number;
    await api.post(`/api/contracts/${counterAddr}/call`).send({ methodId: 0 });
    const after = (await api.get(`/api/contracts/${counterAddr}`)).body.callCount as number;
    expect(after).toBe(before + 1);
  });

  it("fresh contract starts at count 0 regardless of other contracts", async () => {
    const deployRes = await api.post("/api/contracts/deploy").send({
      deployer:    DEPLOYER,
      bytecodeHex: COUNTER_HEX,
    });
    const freshAddr = deployRes.body.address as string;
    const callRes = await api.post(`/api/contracts/${freshAddr}/call`).send({ methodId: 0 });
    expect(callRes.body.returnValue).toBe(0);
  });
});
