import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { BlockRecord, Couplings, NetworkId } from "@/protocol/types";

const Network = z.object({
  network: z.enum(["testnet", "mainnet"]),
});

export const getSnapshot = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    return (await getNode(data.network)).snapshot();
  });

export const getBlock = createServerFn({ method: "POST" })
  .validator(Network.extend({ id: z.string() }))
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    return (await getNode(data.network)).getBlock(data.id) ?? null;
  });

export const getTx = createServerFn({ method: "POST" })
  .validator(Network.extend({ hash: z.string() }))
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    return (await getNode(data.network)).getTx(data.hash) ?? null;
  });

export const getAccount = createServerFn({ method: "POST" })
  .validator(Network.extend({ address: z.string() }))
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    return (await getNode(data.network)).getAccount(data.address.toLowerCase());
  });

export const submitTransaction = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      hash: z.string(),
      from: z.string(),
      to: z.string(),
      amount: z.number(),
      fee: z.number(),
      nonce: z.number(),
      timestamp: z.number(),
      signature: z.string(),
      publicKey: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const { network, ...tx } = data;
    const res = (await getNode(network)).submitTx({
      ...tx,
      status: "pending",
      blockHash: null,
      blockHeight: null,
    });
    if (res.ok) await persist(network);
    return res;
  });

export const requestFaucet = createServerFn({ method: "POST" })
  .validator(Network.extend({ address: z.string() }))
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const res = (await getNode(data.network)).faucet(data.address.toLowerCase());
    if (res.ok) await persist(data.network);
    return res;
  });

export const runExperiment = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      kind: z.enum(["ablate", "pressure", "paired", "whole"]),
      couplings: z
        .object({
          hash: z.number(),
          structural: z.number(),
          continuity: z.number(),
          mempool: z.number(),
          fees: z.number(),
        })
        .optional(),
      inject: z.number().optional(),
      key: z.enum(["hash", "structural", "continuity", "mempool", "fees"]).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const { persistExperiment } = await import("./persist.server");
    const node = await getNode(data.network);
    if (data.kind === "whole") {
      const result = node.measureWhole();
      await persistExperiment(data.network, "whole", result);
      return result;
    }
    if (data.kind === "paired") {
      const result = node.pairedAblation(data.key ?? "mempool", data.inject ?? 12);
      await persistExperiment(data.network, "paired", result);
      await persist(data.network);
      return result;
    }
    const result = node.experiment(data.kind, {
      couplings: data.couplings as Couplings | undefined,
      inject: data.inject,
    });
    await persistExperiment(data.network, data.kind, {
      ...result,
      block: { height: result.block.height, residual: result.block.residual, committedPressure: result.block.committedPressure },
    });
    await persist(data.network);
    return result;
  });

export const listExperimentLog = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { listExperiments } = await import("./persist.server");
    const rows = await listExperiments(data.network);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      created_at: row.created_at,
      result:
        row.result && typeof row.result === "object"
          ? {
              height: Number((row.result as { height?: number }).height ?? 0),
              delta: Number((row.result as { delta?: number }).delta ?? 0),
            }
          : { height: 0, delta: 0 },
    }));
  });

export const swapPool = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      poolId: z.string(),
      trader: z.string(),
      tokenIn: z.string(),
      amountIn: z.number(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    return (await getNode(data.network)).swap(data.poolId, data.trader, data.tokenIn, data.amountIn);
  });

export const executeContract = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      method: z.enum(["init", "pause", "unpause"]),
      caller: z.string(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    const res = await node.executeContract(data.method, data.caller);
    if (res.ok) await persist(data.network);
    return res;
  });

export const bootstrapEth = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    const res = node.bootstrapEth();
    if (res.ok) await persist(data.network);
    return res;
  });

export const admitEthHeader = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    const signed = node.signNextEthHeader("11".repeat(32), "22".repeat(32));
    if (!signed.ok || !signed.header) return { ok: false, error: signed.error ?? "could not sign" };
    const res = node.submitEthHeader(signed.header);
    if (res.ok) await persist(data.network);
    return res;
  });

export const submitBtcHeader = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      headerHex: z.string(),
      height: z.number(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    const res = node.submitBtcHeader(data.headerHex, data.height);
    if (res.ok) await persist(data.network);
    return res;
  });

export const submitExternal = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      hash: z.string(),
      residual: z.number(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode } = await import("./node.server");
    const node = await getNode(data.network);
    const block = node.getBlock(data.hash);
    if (!block) return { ok: false, error: "unknown block", report: null };
    const claimed = { ...block, residual: data.residual, residualFp: 0 };
    return node.submitExternal(claimed);
  });

export const ingestGossip = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      block: z.unknown(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    const res = await node.ingestGossip(data.block as BlockRecord);
    if (res.ok) await persist(data.network);
    return res;
  });

export const stakeAction = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      op: z.enum(["delegate", "slash", "claim", "propose", "vote", "model"]),
      address: z.string(),
      validator: z.string().optional(),
      amount: z.number().optional(),
      title: z.string().optional(),
      id: z.number().optional(),
      option: z.enum(["yes", "no", "abstain"]).optional(),
      uri: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { getNode, persist } = await import("./node.server");
    const node = await getNode(data.network);
    let res: { ok: boolean; error?: string; [k: string]: unknown } = { ok: false, error: "unknown op" };
    if (data.op === "delegate" && data.validator) res = node.delegate(data.address, data.validator, data.amount ?? 0);
    else if (data.op === "slash" && data.validator) res = node.slash(data.validator, "downtime");
    else if (data.op === "claim") res = node.claimRewards(data.address);
    else if (data.op === "propose") res = node.propose(data.address, data.title ?? "untitled", data.amount ?? 1);
    else if (data.op === "vote" && data.id && data.option) res = node.vote(data.address, data.id, data.option);
    else if (data.op === "model") {
      const m = node.proposeModel(data.uri ?? "ipfs://model", 0, "0".repeat(64));
      res = { ok: true, error: undefined, id: m.id };
    }
    if (res.ok) await persist(data.network);
    return { ok: Boolean(res.ok), error: typeof res.error === "string" ? res.error : undefined };
  });

export const listBidirectionalLog = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { persist } = await import("./node.server");
    const { listBidirectional } = await import("./persist.server");
    await persist(data.network);
    return listBidirectional(data.network);
  });

export const listMeshLog = createServerFn({ method: "POST" })
  .validator(Network)
  .handler(async ({ data }) => {
    const { listMesh } = await import("./persist.server");
    return listMesh(data.network);
  });

export const recordMeshSighting = createServerFn({ method: "POST" })
  .validator(
    Network.extend({
      peerId: z.string().min(1).max(64),
      height: z.number(),
      hash: z.string().min(8).max(128),
      agree: z.boolean(),
      detail: z.string().max(240),
    }),
  )
  .handler(async ({ data }) => {
    const { recordMeshSighting: write } = await import("./persist.server");
    await write(data);
    return { ok: true };
  });

export type Snapshot = Awaited<ReturnType<typeof getSnapshot>>;
export type { NetworkId };
