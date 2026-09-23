import { getSql } from "@/lib/db";
import { OrganismNode } from "@/protocol/chain";
import type { NetworkId, PersistedBody } from "@/protocol/types";

export async function persistNode(node: OrganismNode): Promise<void> {
  try {
    const sql = await getSql();
    const body: PersistedBody = node.toBody();
    const tip = node.tip;
    await sql.query(
      `insert into eq_chain_meta (network, difficulty, couplings, height, last_mine_at, body, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (network) do update set
         difficulty = excluded.difficulty,
         couplings = excluded.couplings,
         height = excluded.height,
         last_mine_at = excluded.last_mine_at,
         body = excluded.body,
         updated_at = now()`,
      [
        node.network,
        node.difficulty,
        JSON.stringify(node.couplings),
        node.height,
        node.lastMineAt,
        JSON.stringify(body),
      ],
    );
    if (tip) {
      await sql.query(
        `insert into eq_blocks (network, height, hash, residual, pressure, finalized, body)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (network, height) do update set
           hash = excluded.hash,
           residual = excluded.residual,
           pressure = excluded.pressure,
           finalized = excluded.finalized,
           body = excluded.body`,
        [
          node.network,
          tip.height,
          tip.hash,
          tip.residual,
          tip.committedPressure,
          tip.finalized,
          JSON.stringify(tip),
        ],
      );
    }
  } catch (err) {
    console.error("[equilibrium] persist", err);
  }
}

export async function persistExperiment(network: NetworkId, kind: string, result: unknown): Promise<void> {
  try {
    const sql = await getSql();
    await sql.query(`insert into eq_experiments (network, kind, result) values ($1, $2, $3)`, [
      network,
      kind,
      JSON.stringify(result),
    ]);
  } catch (err) {
    console.error("[equilibrium] persist experiment", err);
  }
}

export async function listExperiments(network: NetworkId, limit = 12) {
  try {
    const sql = await getSql();
    return await sql.query<{
      id: number;
      kind: string;
      result: unknown;
      created_at: string;
    }>(
      `select id, kind, result, created_at::text as created_at
       from eq_experiments where network = $1 order by id desc limit $2`,
      [network, limit],
    );
  } catch {
    return [];
  }
}

export async function restoreNode(network: NetworkId): Promise<OrganismNode> {
  try {
    const sql = await getSql();
    const rows = await sql.query<{ body: unknown }>(
      `select body from eq_chain_meta where network = $1`,
      [network],
    );
    const raw = rows[0]?.body;
    const body = (typeof raw === "string" ? JSON.parse(raw) : raw) as PersistedBody | undefined;
    if (body?.blocks?.length) {
      const node = OrganismNode.restore(network, body);
      node.persisted = true;
      return node;
    }
  } catch (err) {
    console.error("[equilibrium] restore", err);
  }
  const node = new OrganismNode(network);
  node.persisted = false;
  await persistNode(node);
  return node;
}

export async function recordBidirectional(
  network: NetworkId,
  row: {
    height: number;
    claimedR: number;
    inferredR: number;
    agree: boolean;
    discoveryIters: number;
    verifyEvals: number;
  },
): Promise<void> {
  try {
    const sql = await getSql();
    await sql.query(
      `insert into eq_bidirectional
         (network, height, claimed_r, inferred_r, agree, discovery_iters, verify_evals)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (network, height) do update set
         claimed_r = excluded.claimed_r,
         inferred_r = excluded.inferred_r,
         agree = excluded.agree,
         discovery_iters = excluded.discovery_iters,
         verify_evals = excluded.verify_evals`,
      [network, row.height, row.claimedR, row.inferredR, row.agree, row.discoveryIters, row.verifyEvals],
    );
  } catch (err) {
    console.error("[equilibrium] bidirectional", err);
  }
}

export async function listBidirectional(network: NetworkId, limit = 24) {
  try {
    const sql = await getSql();
    return await sql.query<{
      height: number;
      claimed_r: number;
      inferred_r: number;
      agree: boolean;
      discovery_iters: number;
      verify_evals: number;
      created_at: string;
    }>(
      `select height, claimed_r, inferred_r, agree, discovery_iters, verify_evals, created_at::text as created_at
       from eq_bidirectional where network = $1 order by height desc limit $2`,
      [network, limit],
    );
  } catch {
    return [];
  }
}

export async function recordMeshSighting(input: {
  network: NetworkId;
  peerId: string;
  height: number;
  hash: string;
  agree: boolean;
  detail: string;
}): Promise<void> {
  try {
    const sql = await getSql();
    await sql.query(
      `insert into eq_mesh_obs (network, peer_id, height, hash, agree, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.network,
        input.peerId.slice(0, 64),
        input.height,
        input.hash,
        input.agree,
        input.detail.slice(0, 240),
      ],
    );
  } catch (err) {
    console.error("[equilibrium] mesh", err);
  }
}

export async function listMesh(network: NetworkId, limit = 16) {
  try {
    const sql = await getSql();
    return await sql.query<{
      id: number;
      peer_id: string;
      height: number;
      hash: string;
      agree: boolean;
      detail: string;
      created_at: string;
    }>(
      `select id, peer_id, height, hash, agree, detail, created_at::text as created_at
       from eq_mesh_obs where network = $1 order by id desc limit $2`,
      [network, limit],
    );
  } catch {
    return [];
  }
}
