import { Router } from "express";
import { chainState } from "../chain/index.js";
import { COUNTER_CONTRACT_WAT, ADDER_CONTRACT_WAT } from "../chain/wasm.js";

const router = Router();

// GET /api/contracts — list all deployed contracts
router.get("/contracts", (_req, res) => {
  const cs = chainState;
  const contracts = cs.wasmVM.listContracts().map(c => ({
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
// Body: { methodId, args, gasLimit?, caller? }
router.post("/contracts/:address/call", async (req, res) => {
  const { address } = req.params;
  const { methodId = 0, args = [], gasLimit = 1_000_000, caller } = req.body ?? {};

  const cs = chainState;
  cs.wasmVM.setBlockHeight(cs.height);

  const result = await cs.wasmVM.call(address, Number(methodId), args.map(Number), Number(gasLimit));

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
