import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import chainRouter from "./chain.js";
import blocksRouter from "./blocks.js";
import transactionsRouter from "./transactions.js";
import addressesRouter from "./addresses.js";
import mempoolRouter from "./mempool.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(chainRouter);
router.use(blocksRouter);
router.use(transactionsRouter);
router.use(addressesRouter);
router.use(mempoolRouter);

export default router;
