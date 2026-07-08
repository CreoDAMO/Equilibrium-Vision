import { Router } from "express";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { chainState } from "../chain/index.js";
import { COUNTER_CONTRACT_WAT, ADDER_CONTRACT_WAT } from "../chain/wasm.js";

// ── Ed25519 signature helpers (same implementation as governance.ts) ──────────

/**
 * Derive the canonical Equilibrium address from a raw Ed25519 public key.
 * SHA-256(raw_pubkey_bytes)[0..20] as 40 lowercase hex chars.
 */
function addressFromPublicKey(publicKeyHex: string): string {
  const bytes = Buffer.from(publicKeyHex, "hex");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 40);
}

/**
 * Verify an Ed25519 signature using Node.js built-in crypto.
 * Raw 32-byte public keys must be wrapped in a SPKI DER envelope.
 */
function verifyEd25519(publicKeyHex: string, signatureHex: string, message: Buffer): boolean {
  try {
    const rawPubKey = Buffer.from(publicKeyHex, "hex");
    const sig       = Buffer.from(signatureHex, "hex");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer    = Buffer.concat([spkiPrefix, rawPubKey]);
    const keyObject  = createPublicKey({ key: spkiDer, format: "der", type: "spki" });
    return cryptoVerify(null, message, keyObject, sig);
  } catch {
    return false;
  }
}

/**
 * Verify a contract-call signature.
 * Canonical message: UTF-8("contract-call:{address}:{methodId}:{caller}")
 * The caller must sign this message with the private key corresponding to
 * their address before the route will trust the `caller` field.
 */
function verifyCallerSignature(
  publicKeyHex: string,
  signatureHex: string,
  address: string,
  methodId: number,
  caller: string,
): boolean {
  return verifyEd25519(
    publicKeyHex,
    signatureHex,
    Buffer.from(`contract-call:${address}:${methodId}:${caller}`, "utf8"),
  );
}

const hexRe = /^[0-9a-f]+$/;

const router = Router();

// GET /api/contracts — list all deployed contracts
// Query params:
//   deployer  — 40-char hex address; filters to contracts by that deployer
//               (uses contracts_deployer_idx in DB; O(n) filter in-memory)
router.get("/contracts", (req, res) => {
  const cs = chainState;
  const deployerFilter = typeof req.query["deployer"] === "string"
    ? req.query["deployer"].trim().toLowerCase()
    : null;

  let list = cs.wasmVM.listContracts();

  if (deployerFilter) {
    list = list.filter(c => c.deployer === deployerFilter);
  }

  // Newest first — consistent with DB query order (ORDER BY deployed_at DESC)
  list = [...list].sort((a, b) => b.deployedAt - a.deployedAt);

  const contracts = list.map(c => ({
    address: c.address,
    deployer: c.deployer,
    bytecodeHash: c.bytecodeHash,
    deployedAt: c.deployedAt,
    callCount: c.callCount,
    totalGasUsed: c.totalGasUsed,
    abi: c.abi,
  }));
  res.json({ count: contracts.length, contracts });
});

// GET /api/contracts/examples — example WAT contract sources
router.get("/contracts/examples", (_req, res) => {
  res.json({
    examples: [
      {
        name: "Counter",
        description: "Simple counter: method 1 = increment, method 0 = get value",
        wat: COUNTER_CONTRACT_WAT,
        abi: {
          functions: [
            { name: "get", methodId: 0, inputs: [], outputs: ["i32"] },
            { name: "increment", methodId: 1, inputs: [], outputs: ["i32"] },
          ],
        },
      },
      {
        name: "Adder",
        description: "Adds two i32 values: method 1 = add(a, b)",
        wat: ADDER_CONTRACT_WAT,
        abi: {
          functions: [
            { name: "add", methodId: 1, inputs: ["i32", "i32"], outputs: ["i32"] },
          ],
        },
      },
    ],
  });
});

// GET /api/contracts/:address — contract details
router.get("/contracts/:address", (req, res) => {
  const cs = chainState;
  const contract = cs.wasmVM.getContract(req.params.address);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  return res.json({
    ...contract,
    bytecode: contract.bytecode.slice(0, 64) + (contract.bytecode.length > 64 ? "..." : ""),
  });
});

// GET /api/contracts/:address/storage — contract key-value storage
router.get("/contracts/:address/storage", (req, res) => {
  const cs = chainState;
  const storage = cs.wasmVM.getStorage(req.params.address);
  if (!cs.wasmVM.getContract(req.params.address)) {
    return res.status(404).json({ error: "Contract not found" });
  }
  return res.json({ address: req.params.address, storage, keys: Object.keys(storage).length });
});

// GET /api/contracts/:address/events — rolling log() event history (last 200)
router.get("/contracts/:address/events", (req, res) => {
  const cs = chainState;
  const contract = cs.wasmVM.getContract(req.params.address);
  if (!contract) return res.status(404).json({ error: "Contract not found" });
  return res.json({ address: req.params.address, events: contract.events ?? [] });
});

// POST /api/contracts/deploy — deploy a WASM contract
// Body: { deployer, bytecodeHex, abi? }
// To deploy from WAT, client must compile WAT → WASM first, or use bytecodeHex directly.
router.post("/contracts/deploy", async (req, res) => {
  const { deployer, bytecodeHex, abi } = req.body ?? {};
  if (!deployer || !bytecodeHex) {
    return res.status(400).json({ error: "deployer and bytecodeHex are required" });
  }

  const cs = chainState;
  cs.wasmVM.setBlockHeight(cs.height);

  const result = await cs.wasmVM.deploy(deployer, bytecodeHex, abi);
  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  return res.json({
    success: true,
    address: result.address,
    deployer,
    blockHeight: cs.height,
    message: "Contract deployed successfully",
  });
});

// POST /api/contracts/:address/call — call a contract function
// Body: { methodId, args, gasLimit?, caller?, publicKey?, signature? }
//
// When `caller` is provided (non-empty), `publicKey` and `signature` are
// required. The caller must sign the canonical message:
//   "contract-call:{address}:{methodId}:{caller}"
// with the Ed25519 private key whose public key hashes to `caller`.
// This prevents impersonation attacks where an attacker names a victim's
// address in the `caller` field to trigger fund-debiting host functions
// (e.g. `bond` in ModelRegistry) or bypass owner gates on their behalf.
//
// Read-only calls that don't supply a `caller` proceed without a signature.
router.post("/contracts/:address/call", async (req, res) => {
  const { address } = req.params;
  const { methodId = 0, args = [], gasLimit = 1_000_000, caller, publicKey, signature } = req.body ?? {};

  const callerAddr = typeof caller === "string" ? caller.trim().toLowerCase() : "";

  // ── Signature verification (required when caller is specified) ────────────
  if (callerAddr) {
    if (!publicKey || typeof publicKey !== "string" || publicKey.length !== 64 || !hexRe.test(publicKey)) {
      return res.status(400).json({ error: "publicKey (64 hex chars, raw Ed25519) is required when caller is specified" });
    }
    if (!signature || typeof signature !== "string" || signature.length !== 128 || !hexRe.test(signature)) {
      return res.status(400).json({ error: "signature (128 hex chars, Ed25519) is required when caller is specified" });
    }

    // Ensure publicKey actually maps to the claimed caller address.
    const derivedAddr = addressFromPublicKey(publicKey);
    if (derivedAddr !== callerAddr) {
      return res.status(400).json({ error: "publicKey does not correspond to caller address" });
    }

    // Verify the signature over the canonical contract-call message.
    if (!verifyCallerSignature(publicKey, signature, address, Number(methodId), callerAddr)) {
      return res.status(401).json({ error: 'Invalid caller signature — sign "contract-call:{address}:{methodId}:{caller}" with your Ed25519 key' });
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  const cs = chainState;
  cs.wasmVM.setBlockHeight(cs.height);

  const result = await cs.wasmVM.call(address, Number(methodId), args.map(Number), Number(gasLimit), callerAddr);

  if (!result.success) {
    return res.status(400).json({
      success: false,
      error: result.error,
      gasUsed: result.gasUsed,
      logs: result.logs,
    });
  }

  return res.json({
    success: true,
    returnValue: result.returnValue,
    gasUsed: result.gasUsed,
    logs: result.logs,
    address,
    methodId,
  });
});

export default router;
