import { Router, type Request, type Response } from "express";
import { chainState } from "../chain/index.js";
import {
  evmToEquilibrium, equilibriumToEvm,
  jsonRpcSuccess, jsonRpcError,
  formatEVMBlock, equToWei, weiToEQU,
  EVM_CHAIN_ID,
} from "../chain/evm.js";
import { createHash } from "crypto";

const router = Router();

// ── EVM JSON-RPC endpoint ─────────────────────────────────────────────────────
// POST /evm  (JSON-RPC 2.0)
// Supports: eth_chainId, net_version, eth_blockNumber, eth_getBalance,
//           eth_getTransactionCount, eth_getBlockByNumber, eth_getTransactionByHash,
//           eth_sendRawTransaction, eth_call, eth_gasPrice, eth_estimateGas

router.post("/evm", async (req: Request, res: Response) => {
  const body = req.body;
  const id = body?.id ?? null;
  const method = body?.method as string | undefined;
  const params = body?.params ?? [];

  if (!method) {
    return res.json(jsonRpcError(id, -32600, "Invalid Request: missing method"));
  }

  const cs = chainState;

  try {
    switch (method) {
      // ── Chain metadata ──────────────────────────────────────────────────────

      case "eth_chainId":
        return res.json(jsonRpcSuccess(id, "0x" + EVM_CHAIN_ID.toString(16)));

      case "net_version":
        return res.json(jsonRpcSuccess(id, EVM_CHAIN_ID.toString()));

      case "eth_blockNumber":
        return res.json(jsonRpcSuccess(id, "0x" + cs.height.toString(16)));

      case "eth_gasPrice":
        // Fixed base fee: 1 Gwei
        return res.json(jsonRpcSuccess(id, "0x3b9aca00"));

      case "eth_estimateGas":
        // Simple fixed estimate
        return res.json(jsonRpcSuccess(id, "0x5208")); // 21000

      // ── Account queries ─────────────────────────────────────────────────────

      case "eth_getBalance": {
        const [evmAddr, _block] = params as [string, string];
        const addr = evmToEquilibrium(evmAddr);
        const balance = cs.ledger.balance(addr);
        const wei = equToWei(balance / 1e8); // EQU stored as satoshis, convert to 18-decimal
        return res.json(jsonRpcSuccess(id, "0x" + wei.toString(16)));
      }

      case "eth_getTransactionCount": {
        const [evmAddr, _block] = params as [string, string];
        const addr = evmToEquilibrium(evmAddr);
        const nonce = cs.ledger.nonce(addr);
        return res.json(jsonRpcSuccess(id, "0x" + nonce.toString(16)));
      }

      case "eth_getCode": {
        const [evmAddr] = params as [string];
        const addr = evmToEquilibrium(evmAddr);
        const contract = cs.wasmVM.getContract(addr);
        if (!contract) return res.json(jsonRpcSuccess(id, "0x"));
        return res.json(jsonRpcSuccess(id, "0x" + contract.bytecode.slice(0, 64)));
      }

      // ── Block queries ───────────────────────────────────────────────────────

      case "eth_getBlockByNumber": {
        const [blockParam, _full] = params as [string, boolean];
        let blockIndex: number;
        if (blockParam === "latest") blockIndex = cs.height;
        else if (blockParam === "earliest") blockIndex = 0;
        else if (blockParam === "pending") blockIndex = cs.height;
        else blockIndex = parseInt(blockParam, 16);

        const block = cs.blocks[blockIndex];
        if (!block) return res.json(jsonRpcSuccess(id, null));

        return res.json(jsonRpcSuccess(id, formatEVMBlock({
          hash: block.hash,
          height: block.height,
          timestamp: block.timestamp,
          minerAddress: block.miner,
          difficulty: block.difficulty,
          txHashes: block.transactions.map(t => t.hash),
          merkleRoot: block.merkleRoot,
        })));
      }

      case "eth_getBlockByHash": {
        const [blockHash] = params as [string];
        const hash = blockHash.replace(/^0x/, "");
        const block = cs.blocks.find(b => b.hash === hash);
        if (!block) return res.json(jsonRpcSuccess(id, null));
        return res.json(jsonRpcSuccess(id, formatEVMBlock({
          hash: block.hash,
          height: block.height,
          timestamp: block.timestamp,
          minerAddress: block.miner,
          difficulty: block.difficulty,
          txHashes: block.transactions.map(t => t.hash),
          merkleRoot: block.merkleRoot,
        })));
      }

      // ── Transaction queries ─────────────────────────────────────────────────

      case "eth_getTransactionByHash": {
        const [txHash] = params as [string];
        const hash = txHash.replace(/^0x/, "");
        const tx = cs.txIndex.get(hash);
        if (!tx) return res.json(jsonRpcSuccess(id, null));
        return res.json(jsonRpcSuccess(id, {
          hash: "0x" + tx.hash,
          nonce: "0x" + tx.nonce.toString(16),
          blockHash: tx.blockHash ? "0x" + tx.blockHash : null,
          blockNumber: tx.blockHeight !== null ? "0x" + tx.blockHeight.toString(16) : null,
          transactionIndex: "0x0",
          from: equilibriumToEvm(tx.from),
          to: equilibriumToEvm(tx.to),
          value: "0x" + equToWei(tx.amount / 1e8).toString(16),
          gasPrice: "0x3b9aca00",
          gas: "0x5208",
          input: "0x",
          v: "0x1",
          r: "0x" + tx.hash.slice(0, 64),
          s: "0x" + tx.hash.slice(0, 64),
        }));
      }

      case "eth_getTransactionReceipt": {
        const [txHash] = params as [string];
        const hash = txHash.replace(/^0x/, "");
        const tx = cs.txIndex.get(hash);
        if (!tx || tx.status !== "confirmed") return res.json(jsonRpcSuccess(id, null));
        return res.json(jsonRpcSuccess(id, {
          transactionHash: "0x" + tx.hash,
          transactionIndex: "0x0",
          blockHash: tx.blockHash ? "0x" + tx.blockHash : "0x" + "0".repeat(64),
          blockNumber: tx.blockHeight !== null ? "0x" + tx.blockHeight.toString(16) : "0x0",
          from: equilibriumToEvm(tx.from),
          to: equilibriumToEvm(tx.to),
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          logs: [],
          status: "0x1",
          contractAddress: null,
        }));
      }

      // ── Send / call ─────────────────────────────────────────────────────────

      case "eth_sendRawTransaction": {
        // Accept a raw EVM tx; decode the 'to', 'value', and forward as an EQU tx.
        // In production this would decode RLP-encoded signed tx.
        return res.json(jsonRpcError(id, -32003, "eth_sendRawTransaction: use POST /api/tx/broadcast for signed EQU transactions"));
      }

      case "eth_call": {
        const [callObj] = params as [{ to?: string; from?: string; data?: string; value?: string }];
        const addr = callObj.to ? evmToEquilibrium(callObj.to) : "";
        const contract = cs.wasmVM.getContract(addr);
        if (!contract) {
          return res.json(jsonRpcSuccess(id, "0x"));
        }
        // Decode function selector from calldata (first 4 bytes)
        const data = (callObj.data ?? "").replace(/^0x/, "");
        const methodId = data.length >= 8 ? parseInt(data.slice(0, 8), 16) % 256 : 0;
        const result = await cs.wasmVM.call(addr, methodId, []);
        if (!result.success) {
          return res.json(jsonRpcError(id, -32015, result.error ?? "Execution reverted"));
        }
        const returnHex = result.returnValue !== null
          ? "0x" + result.returnValue.toString(16).padStart(64, "0")
          : "0x";
        return res.json(jsonRpcSuccess(id, returnHex));
      }

      default:
        return res.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
    }
  } catch (e) {
    return res.json(jsonRpcError(id, -32603, (e as Error).message));
  }
});

// GET /api/evm/chainid — quick info
router.get("/evm/chainid", (_req, res) => {
  res.json({
    chainId: EVM_CHAIN_ID,
    chainIdHex: "0x" + EVM_CHAIN_ID.toString(16),
    name: "Equilibrium",
    network: "devnet",
    rpcUrl: "/evm",
    nativeCurrency: { name: "Equilibrium", symbol: "EQU", decimals: 18 },
  });
});

// GET /api/evm/accounts — list EVM-style addresses for all known accounts
router.get("/evm/accounts", (req, res) => {
  const cs = chainState;
  // We expose validator addresses as EVM accounts for testing
  const accounts = [...cs.validators.values()].map(v => ({
    address: equilibriumToEvm(v.address),
    equilibriumAddress: v.address,
    balance: "0x" + equToWei(cs.ledger.balance(v.address) / 1e8).toString(16),
  }));
  res.json({ chainId: EVM_CHAIN_ID, accounts });
});

export default router;
