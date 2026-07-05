/**
 * Admin multisig tests — native WASM M-of-N multisig contract (multisig.wat)
 * plus the /api/admin/multisig* + /api/validators/:addr/slash route wiring
 * that replaces the single ADMIN_KEY secret with an on-chain approval gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { WasmVM } from "../chain/wasm.js";
import {
  proposeAdminAction,
  approveAdminAction,
  isAdminActionApproved,
  getMultisigInfo,
} from "../chain/multisig.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEPLOYER = "aabbccddee1122334455aabbccddee1122334455";

async function compileMultisig(): Promise<string> {
  const wabtModule = await import("wabt");
  const wabt = await wabtModule.default();
  const watPath = join(__dirname, "..", "chain", "contracts", "multisig.wat");
  const wat = readFileSync(watPath, "utf-8");
  const mod = wabt.parseWat("multisig.wat", wat);
  mod.resolveNames();
  mod.validate();
  const { buffer } = mod.toBinary({});
  return Buffer.from(buffer).toString("hex");
}

function addressFromPubkey(pubkey: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(pubkey)).digest("hex").slice(0, 40);
}

function addressToWords(addr: string): number[] {
  const bytes = new TextEncoder().encode(addr);
  const words: number[] = [];
  for (let i = 0; i < 10; i++) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i * 4 + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

function bytesToWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

const METHOD = { INIT: 0, ADD_OWNER: 1, FINALIZE: 2, PROPOSE: 3, APPROVE: 4, IS_APPROVED: 5 };

describe("Multisig WASM contract — raw call ABI", () => {
  let vm: WasmVM;
  let address: string;
  const owners: { sk: Uint8Array; pk: Uint8Array; addr: string }[] = [];

  beforeAll(async () => {
    const bytecodeHex = await compileMultisig();
    vm = new WasmVM();
    const { address: addr, error } = await vm.deploy(DEPLOYER, bytecodeHex);
    expect(error).toBeUndefined();
    address = addr;

    for (let i = 0; i < 3; i++) {
      const sk = ed25519.utils.randomSecretKey();
      const pk = ed25519.getPublicKey(sk);
      owners.push({ sk, pk, addr: addressFromPubkey(pk) });
    }
  });

  function signApprove(sk: Uint8Array, proposalId: number): Uint8Array {
    const msg = new TextEncoder().encode(`equilibrium-multisig-approve:${address}:${proposalId}`);
    return ed25519.sign(msg, sk);
  }

  it("initializes with a threshold", async () => {
    const res = await vm.call(address, METHOD.INIT, [2]);
    expect(res.returnValue).toBe(1);
  });

  it("rejects double initialization", async () => {
    const res = await vm.call(address, METHOD.INIT, [2]);
    expect(res.returnValue).toBe(-1);
  });

  it("registers owners in order", async () => {
    for (let i = 0; i < owners.length; i++) {
      const res = await vm.call(address, METHOD.ADD_OWNER, addressToWords(owners[i]!.addr));
      expect(res.returnValue).toBe(i);
    }
  });

  it("finalizes once threshold <= owner count", async () => {
    const res = await vm.call(address, METHOD.FINALIZE, []);
    expect(res.returnValue).toBe(1);
  });

  it("rejects addOwner after finalize", async () => {
    const res = await vm.call(address, METHOD.ADD_OWNER, addressToWords(owners[0]!.addr));
    expect(res.returnValue).toBe(-1);
  });

  it("creates sequential proposals", async () => {
    const r1 = await vm.call(address, METHOD.PROPOSE, []);
    expect(r1.returnValue).toBe(0);
    const r2 = await vm.call(address, METHOD.PROPOSE, []);
    expect(r2.returnValue).toBe(1);
  });

  it("requires threshold approvals before isApproved flips to true", async () => {
    const propId = 0;
    expect((await vm.call(address, METHOD.IS_APPROVED, [propId])).returnValue).toBe(0);

    const sig0 = signApprove(owners[0]!.sk, propId);
    const r0 = await vm.call(address, METHOD.APPROVE, [
      propId, 0, ...bytesToWords(owners[0]!.pk), ...bytesToWords(sig0),
    ]);
    expect(r0.returnValue).toBe(1); // pending, threshold not yet met
    expect((await vm.call(address, METHOD.IS_APPROVED, [propId])).returnValue).toBe(0);

    const sig1 = signApprove(owners[1]!.sk, propId);
    const r1 = await vm.call(address, METHOD.APPROVE, [
      propId, 1, ...bytesToWords(owners[1]!.pk), ...bytesToWords(sig1),
    ]);
    expect(r1.returnValue).toBe(2); // threshold met
    expect((await vm.call(address, METHOD.IS_APPROVED, [propId])).returnValue).toBe(1);
  });

  it("rejects approval on an already-fully-approved proposal", async () => {
    const propId = 0;
    const sig = signApprove(owners[2]!.sk, propId);
    const res = await vm.call(address, METHOD.APPROVE, [
      propId, 2, ...bytesToWords(owners[2]!.pk), ...bytesToWords(sig),
    ]);
    expect(res.returnValue).toBe(-3);
  });

  it("rejects a tampered signature", async () => {
    const propId = 1;
    const sig = signApprove(owners[0]!.sk, propId);
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0xff;
    const res = await vm.call(address, METHOD.APPROVE, [
      propId, 0, ...bytesToWords(owners[0]!.pk), ...bytesToWords(tampered),
    ]);
    expect(res.returnValue).toBe(0);
  });

  it("rejects an out-of-range owner index", async () => {
    const propId = 1;
    const sig = signApprove(owners[0]!.sk, propId);
    const res = await vm.call(address, METHOD.APPROVE, [
      propId, 99, ...bytesToWords(owners[0]!.pk), ...bytesToWords(sig),
    ]);
    expect(res.returnValue).toBe(-4);
  });

  it("rejects an unknown proposal id", async () => {
    const sig = signApprove(owners[0]!.sk, 999);
    const res = await vm.call(address, METHOD.APPROVE, [
      999, 0, ...bytesToWords(owners[0]!.pk), ...bytesToWords(sig),
    ]);
    expect(res.returnValue).toBe(-2);
  });

  it("rejects impersonation — valid signature for the wrong owner slot", async () => {
    const propId = 1;
    // owner 1's key claiming to be owner 0
    const sig = signApprove(owners[1]!.sk, propId);
    const res = await vm.call(address, METHOD.APPROVE, [
      propId, 0, ...bytesToWords(owners[1]!.pk), ...bytesToWords(sig),
    ]);
    expect(res.returnValue).toBe(0);
  });

  it("rejects cross-proposal signature replay", async () => {
    // signed for proposal 0, submitted against proposal 1
    const sig = signApprove(owners[0]!.sk, 0);
    const res = await vm.call(address, METHOD.APPROVE, [
      1, 0, ...bytesToWords(owners[0]!.pk), ...bytesToWords(sig),
    ]);
    expect(res.returnValue).toBe(0);
  });
});

// ── TS integration layer + route wiring ─────────────────────────────────────

import supertest from "supertest";
import app from "../app.js";
import { initChain, stopMining, chainState } from "../chain/index.js";

const api = supertest(app);

describe("Admin multisig — TS wrapper + slash route gating", () => {
  const owners: { sk: Uint8Array; pk: Uint8Array; addr: string }[] = [];
  let multisigAddress: string;

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const sk = ed25519.utils.randomSecretKey();
      const pk = ed25519.getPublicKey(sk);
      owners.push({ sk, pk, addr: addressFromPubkey(pk) });
    }
    process.env["ADMIN_MULTISIG_OWNERS"] = owners.map((o) => o.addr).join(",");
    process.env["ADMIN_MULTISIG_THRESHOLD"] = "2";
    delete process.env["ADMIN_MULTISIG_ADDRESS"];

    await initChain();
    const info = getMultisigInfo(chainState.wasmVM);
    expect(info.configured).toBe(true);
    expect(info.finalized).toBe(true);
    multisigAddress = info.address!;
  }, 30_000);

  afterAll(() => {
    stopMining();
    delete process.env["ADMIN_MULTISIG_OWNERS"];
    delete process.env["ADMIN_MULTISIG_THRESHOLD"];
  });

  function signApprove(sk: Uint8Array, proposalId: number): string {
    const msg = new TextEncoder().encode(`equilibrium-multisig-approve:${multisigAddress}:${proposalId}`);
    return Buffer.from(ed25519.sign(msg, sk)).toString("hex");
  }

  it("GET /api/admin/multisig reports deployed contract info", async () => {
    const res = await api.get("/api/admin/multisig");
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.ownerCount).toBe(2);
    expect(res.body.threshold).toBe(2);
    expect(res.body.finalized).toBe(true);
  });

  it("blocks slash without proposalId once multisig is configured", async () => {
    const validatorAddr = [...chainState.validators.keys()][0]!;
    const res = await api
      .post(`/api/validators/${validatorAddr}/slash`)
      .send({ reason: "downtime" });
    expect(res.status).toBe(400);
  });

  it("blocks slash for an unapproved proposal", async () => {
    const propose = await api.post("/api/admin/multisig/propose").send({});
    expect(propose.status).toBe(200);
    const proposalId = propose.body.proposalId;

    const validatorAddr = [...chainState.validators.keys()][0]!;
    const res = await api
      .post(`/api/validators/${validatorAddr}/slash`)
      .send({ reason: "downtime", proposalId });
    expect(res.status).toBe(403);
  });

  it("allows slash once threshold approvals are collected via the API", async () => {
    const propose = await api.post("/api/admin/multisig/propose").send({});
    const proposalId = propose.body.proposalId;

    const a0 = await api.post(`/api/admin/multisig/${proposalId}/approve`).send({
      ownerIndex: 0,
      pubkey: Buffer.from(owners[0]!.pk).toString("hex"),
      signature: signApprove(owners[0]!.sk, proposalId),
    });
    expect(a0.status).toBe(200);
    expect(a0.body.thresholdMet).toBe(false);

    const a1 = await api.post(`/api/admin/multisig/${proposalId}/approve`).send({
      ownerIndex: 1,
      pubkey: Buffer.from(owners[1]!.pk).toString("hex"),
      signature: signApprove(owners[1]!.sk, proposalId),
    });
    expect(a1.status).toBe(200);
    expect(a1.body.thresholdMet).toBe(true);

    const check = await api.get(`/api/admin/multisig/${proposalId}`);
    expect(check.body.approved).toBe(true);

    const validatorAddr = [...chainState.validators.keys()][0]!;
    const slash = await api
      .post(`/api/validators/${validatorAddr}/slash`)
      .send({ reason: "downtime", proposalId });
    expect(slash.status).toBe(200);
    expect(slash.body.success).toBe(true);
  });

  it("rejects an approve() call with a forged signature via the API", async () => {
    const propose = await api.post("/api/admin/multisig/propose").send({});
    const proposalId = propose.body.proposalId;
    const sig = signApprove(owners[0]!.sk, proposalId);
    const tampered = Buffer.from(sig, "hex");
    tampered[0] ^= 0xff;

    const res = await api.post(`/api/admin/multisig/${proposalId}/approve`).send({
      ownerIndex: 0,
      pubkey: Buffer.from(owners[0]!.pk).toString("hex"),
      signature: tampered.toString("hex"),
    });
    expect(res.status).toBe(400);
  });

  it("proposeAdminAction/approveAdminAction/isAdminActionApproved wrappers work end-to-end", async () => {
    const propose = await proposeAdminAction(chainState.wasmVM);
    expect(propose.success).toBe(true);
    const proposalId = propose.proposalId!;

    expect(await isAdminActionApproved(chainState.wasmVM, proposalId)).toBe(false);

    const a0 = await approveAdminAction(
      chainState.wasmVM,
      proposalId,
      0,
      Buffer.from(owners[0]!.pk).toString("hex"),
      signApprove(owners[0]!.sk, proposalId),
    );
    expect(a0.success).toBe(true);
    expect(a0.thresholdMet).toBe(false);

    const a1 = await approveAdminAction(
      chainState.wasmVM,
      proposalId,
      1,
      Buffer.from(owners[1]!.pk).toString("hex"),
      signApprove(owners[1]!.sk, proposalId),
    );
    expect(a1.success).toBe(true);
    expect(a1.thresholdMet).toBe(true);

    expect(await isAdminActionApproved(chainState.wasmVM, proposalId)).toBe(true);
  });
});
