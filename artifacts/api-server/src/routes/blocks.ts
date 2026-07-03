import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

router.get("/blocks", (req, res) => {
  const page = Math.max(1, Number(req.query["page"]) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query["limit"]) || 20));
  const all = [...chainState.blocks].reverse();
  const total = all.length;
  const blocks = all.slice((page - 1) * limit, page * limit);
  res.json({ blocks, total, page, limit });
});

router.get("/blocks/:hashOrHeight", (req, res) => {
  const { hashOrHeight } = req.params;
  let block =
    chainState.getBlockByHash(hashOrHeight) ??
    (/^\d+$/.test(hashOrHeight)
      ? chainState.getBlockByHeight(Number(hashOrHeight))
      : undefined);

  if (!block) {
    res.status(404).json({ error: "Block not found" });
    return;
  }
  res.json(block);
});

export default router;
