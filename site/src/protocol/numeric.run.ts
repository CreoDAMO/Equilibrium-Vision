/**
 * Foreign nonce stays an exact u64 through the decoder, the solver result,
 * the residual bytes, the header, and G. A PostgreSQL BIGINT round-trip is
 * executed here when a server is reachable. PGlite covers the same drizzle
 * column when it is not.
 *
 *   NODE_ENV=production tsx site/src/protocol/numeric.run.ts
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { canonicalHeaderHash as siteHeader } from "./crypto";
import { applySuccessor, initialOmega, openedCouplings, transitionDigest } from "./constitution";
import { asBlockNonce, foreignNonce, stringifyCanonical, wireNonce } from "./domain";
import { minerKey } from "./genesis";
import { blankEvidence } from "./seal";
import { evaluateResidual, solveStationary } from "./solver";
import { canonicalHeaderHash as nodeHeader } from "../../../artifacts/api-server/src/chain/crypto.ts";
import { canonicalResidual, residualFingerprint } from "../../../artifacts/api-server/src/chain/canonical-residual.ts";
import { blocksTable } from "../../../lib/db/src/schema/blocks.ts";

const TWO_53 = 1n << 53n;
const CORPUS = [0n, 1n, TWO_53, TWO_53 + 1n, TWO_53 + 2n, (1n << 64n) - 1n];

for (const n of CORPUS) {
  assert.equal(foreignNonce(n), n);
  assert.equal(foreignNonce(n.toString()), n);
  const wire = JSON.parse(stringifyCanonical({ nonce: n })) as { nonce: number | string };
  assert.equal(foreignNonce(wire.nonce), n);
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) {
    assert.equal(typeof wire.nonce, "number");
    assert.equal(wireNonce(n), Number(n));
  } else {
    assert.equal(typeof wire.nonce, "string");
    assert.equal(wire.nonce, n.toString());
  }
}

assert.equal(foreignNonce(6), 6n);
assert.equal(foreignNonce("0"), 0n);
assert.equal(foreignNonce("9007199254740993"), TWO_53 + 1n);
assert.equal(foreignNonce("18446744073709551615"), (1n << 64n) - 1n);
assert.notEqual(foreignNonce(TWO_53), foreignNonce(TWO_53 + 1n));
assert.equal(Number(TWO_53), Number(TWO_53 + 1n));

const refused = [
  undefined,
  null,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -1n,
  1.5,
  Number(TWO_53),
  "",
  "01",
  "1.5",
  "-1",
  "bad",
  "18446744073709551616",
  {},
  [],
  true,
];
for (const value of refused) {
  assert.throws(() => foreignNonce(value), /nonce is not a u64/);
}

const quiet = {
  prevHash: "00".repeat(32),
  merkleRoot: "00".repeat(32),
  timestamp: 1_700_000_000,
  difficulty: 1_000_000,
};
const state = { cumulativeWork: 1, mempoolPressure: 0 };
const fp6 = evaluateResidual({ ...quiet, nonce: 6n }, [], state).canonicalFp;
const fp6number = evaluateResidual({ ...quiet, nonce: 6 }, [], state).canonicalFp;
assert.equal(fp6, 201_100_202_523_998);
assert.equal(fp6number, fp6);
const node6 = canonicalResidual({ ...quiet, nonce: 6n }, [], state);
const node6number = canonicalResidual({ ...quiet, nonce: 6 }, [], state);
assert.equal(node6, node6number);
assert.equal(residualFingerprint(node6), BigInt(fp6));
assert.throws(() => canonicalResidual({ ...quiet, nonce: Number(TWO_53 + 1n) }, [], state), /u64 refused/);

const digest53 = evaluateResidual({ ...quiet, nonce: TWO_53 }, [], state).hashVal;
const digest53next = evaluateResidual({ ...quiet, nonce: TWO_53 + 1n }, [], state).hashVal;
assert.notEqual(digest53, digest53next);
assert.notEqual(
  canonicalResidual({ ...quiet, nonce: TWO_53 }, [], state),
  canonicalResidual({ ...quiet, nonce: TWO_53 + 1n }, [], state),
);

const solved = solveStationary({
  header: { ...quiet, nonce: 42 },
  txs: [],
  state,
  maxIter: 0,
  recursionDepth: 1,
});
assert.equal(typeof solved.nonce, "bigint");
assert.equal(solved.nonce, 42n);
assert.equal(asBlockNonce(solved.nonce), 42n);
const searched = solveStationary({
  header: { ...quiet, nonce: 7 },
  txs: [],
  state,
  maxIter: 8,
  recursionDepth: 1,
  target: 0,
});
assert.equal(typeof searched.nonce, "bigint");
assert.ok(searched.nonce >= 0n && searched.nonce <= 0xffffffffn);

const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
function inputs(nonce: bigint) {
  return {
    transactions: [] as [],
    evidence: blankEvidence(omega.chainId),
    timestamp: 1_700_000_000,
    nonce,
    miner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

const headers = new Set<string>();
const transitions = new Set<string>();
for (const n of CORPUS) {
  const row = inputs(n);
  const stepped = applySuccessor(omega, row);
  assert.equal(stepped.ok, true, stepped.ok ? "" : stepped.error);
  if (!stepped.ok) throw new Error("successor");
  const site = siteHeader({
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    stateRoot: stepped.stateRoot,
    timestamp: row.timestamp,
    nonce: row.nonce,
    difficulty: row.difficulty,
    residualFp: stepped.residualFp,
    miner,
    height: 0,
    committedPressure: 0,
  });
  const node = nodeHeader({
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    stateRoot: stepped.stateRoot,
    timestamp: row.timestamp,
    nonce: row.nonce,
    difficulty: row.difficulty,
    residualFp: stepped.residualFp,
    miner,
    height: 0,
    committedPressure: 0,
  });
  assert.equal(node, site);
  if (n <= BigInt(Number.MAX_SAFE_INTEGER)) {
    assert.equal(nodeHeader({
      prevHash: omega.tipHash,
      merkleRoot: "0".repeat(64),
      stateRoot: stepped.stateRoot,
      timestamp: row.timestamp,
      nonce: Number(n),
      difficulty: row.difficulty,
      residualFp: stepped.residualFp,
      miner,
      height: 0,
      committedPressure: 0,
    }), site);
  }
  headers.add(site);
  transitions.add(transitionDigest(omega, row));
  assert.equal(transitionDigest(omega, row), transitionDigest(omega, { ...row, nonce: foreignNonce(n.toString()) }));
}
assert.equal(headers.size, CORPUS.length);
assert.equal(transitions.size, CORPUS.length);
const low = applySuccessor(omega, inputs(TWO_53));
const high = applySuccessor(omega, inputs(TWO_53 + 1n));
assert.equal(low.ok && high.ok, true);
if (!low.ok || !high.ok) throw new Error("pair");
assert.notEqual(transitionDigest(omega, inputs(TWO_53)), transitionDigest(omega, inputs(TWO_53 + 1n)));
assert.notEqual(
  siteHeader({
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    stateRoot: low.stateRoot,
    timestamp: 1_700_000_000,
    nonce: TWO_53,
    difficulty: omega.difficulty,
    residualFp: low.residualFp,
    miner,
    height: 0,
    committedPressure: 0,
  }),
  siteHeader({
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    stateRoot: high.stateRoot,
    timestamp: 1_700_000_000,
    nonce: TWO_53 + 1n,
    difficulty: omega.difficulty,
    residualFp: high.residualFp,
    miner,
    height: 0,
    committedPressure: 0,
  }),
);

const client = new PGlite();
await client.exec(`
  CREATE TABLE blocks (
    hash text PRIMARY KEY,
    height integer NOT NULL,
    prev_hash text NOT NULL,
    merkle_root text NOT NULL,
    timestamp bigint NOT NULL,
    nonce numeric(20,0) NOT NULL,
    difficulty real NOT NULL,
    residual real NOT NULL,
    residual_fp bigint,
    miner text NOT NULL,
    tx_count integer NOT NULL DEFAULT 0,
    coinbase_reward bigint NOT NULL DEFAULT 0,
    finalized boolean NOT NULL DEFAULT false,
    zk_proof jsonb,
    state_root text,
    committed_pressure double precision,
    chain_id integer,
    evidence_root text,
    omega_root text,
    evidence jsonb
  );
`);
const db = drizzle(client, { schema: { blocksTable } });
const version = (await client.query<{ version: string }>("select version() as version")).rows[0]?.version ?? "";
for (const n of CORPUS) {
  const stepped = applySuccessor(omega, inputs(n));
  if (!stepped.ok) throw new Error(stepped.error);
  const hash = siteHeader({
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    stateRoot: stepped.stateRoot,
    timestamp: 1_700_000_000,
    nonce: n,
    difficulty: omega.difficulty,
    residualFp: stepped.residualFp,
    miner,
    height: 0,
    committedPressure: 0,
  });
  await db.insert(blocksTable).values({
    hash,
    height: 0,
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    timestamp: 1_700_000_000,
    nonce: asBlockNonce(foreignNonce(n.toString())),
    difficulty: omega.difficulty,
    residual: stepped.residual,
    residualFp: stepped.residualFp,
    miner,
    txCount: 0,
    coinbaseReward: 0,
    finalized: false,
  });
  const [row] = await db.select().from(blocksTable).where(eq(blocksTable.hash, hash));
  if (!row) throw new Error(`row ${n} missing`);
  assert.equal(typeof row.nonce, "bigint");
  assert.equal(row.nonce, n);
  const replay = applySuccessor(omega, inputs(row.nonce));
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error("replay");
  assert.equal(replay.omegaRoot, stepped.omegaRoot);
  assert.equal(siteHeader({
    prevHash: row.prevHash,
    merkleRoot: row.merkleRoot,
    stateRoot: replay.stateRoot,
    timestamp: row.timestamp,
    nonce: row.nonce,
    difficulty: row.difficulty,
    residualFp: replay.residualFp,
    miner: row.miner,
    height: row.height,
    committedPressure: 0,
  }), hash);
}
await client.close();

let nodePg: { executed: boolean; reason: string } = {
  executed: false,
  reason: "DATABASE_URL is not set; persistBlock was not run",
};
if (process.env.DATABASE_URL) {
  const { persistBlock, loadBlocksFromDb, closePersistence, getRawPool } = await import(
    "../../../artifacts/api-server/src/chain/persistence.ts"
  );
  const pool = getRawPool();
  if (!pool) {
    nodePg = { executed: false, reason: "pool was not created" };
  } else {
    try {
      await pool.query("select 1");
      const { readFileSync } = await import("node:fs");
      const schemaPath = new URL("../../../artifacts/api-server/src/restart/schema.sql", import.meta.url);
      await pool.query(readFileSync(schemaPath, "utf8"));
      for (const n of CORPUS) {
        const hash = `aa${n.toString(16).padStart(62, "0")}`;
        await persistBlock({
          hash,
          height: 1,
          prevHash: "11".repeat(32),
          merkleRoot: "0".repeat(64),
          timestamp: 1_700_000_000,
          nonce: n,
          difficulty: 1,
          residual: 0,
          recursionDepth: 2,
          coinbaseReward: 0,
          miner: "ab".repeat(20),
          txCount: 0,
          transactions: [],
          finalized: false,
          evidence: { v: 1, chainId: 1, wasmCode: "", btc: [], eth: [], wasm: [], stake: [], cognition: [], settle: [] },
        });
      }
      const loaded = await loadBlocksFromDb();
      for (const n of CORPUS) {
        const hash = `aa${n.toString(16).padStart(62, "0")}`;
        const row = loaded?.find((block) => block.hash === hash);
        if (!row) throw new Error(`persistBlock did not reload ${n}`);
        assert.equal(row.nonce, n);
        await pool.query("delete from blocks where hash = $1", [hash]);
      }
      nodePg = { executed: true, reason: "persistBlock → loadBlocksFromDb" };
    } catch (err) {
      nodePg = { executed: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await closePersistence();
    }
  }
}
if (process.env.DATABASE_URL && !nodePg.executed) {
  throw new Error(nodePg.reason);
}

console.log(JSON.stringify({
  ok: true,
  corpus: CORPUS.map((n) => n.toString()),
  distinctAt2_53: true,
  solverNonce: solved.nonce.toString(),
  searchedNonce: searched.nonce.toString(),
  nonce6Fp: fp6,
  pglite: version.split(" ").slice(0, 2).join(" "),
  nodePg,
}));
