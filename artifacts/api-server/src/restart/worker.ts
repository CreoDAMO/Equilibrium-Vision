/**
 * Two processes, one database.
 *   node worker.ts write    persists a tip and the state the next block reads
 *   node worker.ts read     initChain() after Postgres was killed and started again
 *
 * The read process is not the write process. getDb() is a process singleton.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { ChainState } from "../chain/state.js";
import {
  closePersistence,
  loadAllBlocksRaw,
  loadLatestSnapshot,
  persistBlock,
  saveStateSnapshot,
} from "../chain/persistence.js";
import { canonicalResidual } from "../chain/canonical-residual.js";
import { rebuildStateSmt } from "../chain/state-root.js";
import type { BlockRecord } from "../chain/types.js";

const reportPath = process.env["RESTART_REPORT"] ?? "/tmp/eq-restart-report.json";
const alice = "a".repeat(40);
const miner = "b".repeat(40);
const validator = "c".repeat(40);
const stakeKey = `${alice}-${validator}`;

function block(height: number, timestamp: number, prev: string, difficulty: number): BlockRecord {
  return {
    hash: height.toString(16).padStart(64, "0"),
    height,
    prevHash: prev,
    merkleRoot: "0".repeat(64),
    timestamp,
    nonce: 6,
    difficulty,
    residual: 1e-6,
    recursionDepth: 2,
    coinbaseReward: 100,
    miner,
    txCount: 0,
    transactions: [],
    finalized: false,
  };
}

function seed(state: ChainState): void {
  state.ledger.credit(alice, 4_000);
  state.dexPools.set("EQU-USDC", {
    id: "EQU-USDC",
    tokenA: "EQU",
    tokenB: "USDC",
    reserveA: 50_000,
    reserveB: 40_000,
    totalLiquidity: 1,
    fee: 0.003,
    volumeA: 0,
    volumeB: 0,
    txCount: 3,
    createdAt: 1,
  });
  state.validators.set(validator, {
    address: validator,
    moniker: "carol",
    bondedStake: 2_000,
    accumulatedRewards: 0,
    slashed: false,
    slashCount: 0,
    jailed: false,
    uptime: 1,
    blocksProposed: 0,
    blocksVoted: 0,
    commission: 0.1,
  });
  state.stakes.set(stakeKey, {
    delegator: alice,
    validator,
    amount: 500,
    startHeight: 0,
    startTimestamp: 1,
    unbonding: false,
    rewardsEarned: 0,
  });
}

async function writeReport(): Promise<void> {
  const state = new ChainState();
  seed(state);
  const b0 = block(0, 1_700_000_000, "0".repeat(64), state.currentDifficulty);
  state.addBlock(b0);
  const b1 = block(1, 1_700_000_001, b0.hash, state.currentDifficulty);
  state.addBlock(b1);
  if (state.currentDifficulty !== 1_200_000) {
    throw new Error(`a 1s block should clamp difficulty to 1200000, got ${state.currentDifficulty}`);
  }
  const root = rebuildStateSmt(state).root();
  if (!b1.stateRoot || b1.stateRoot !== root) throw new Error("tip state root is not the rebuilt root");

  await persistBlock(b0);
  await persistBlock(b1);
  const persisted = await loadAllBlocksRaw();
  if (!persisted || persisted.length !== 2 || persisted[1]?.hash !== b1.hash) {
    throw new Error("persistBlock did not leave both blocks in Postgres");
  }
  const snap = state.exportRestartSnapshot();
  await saveStateSnapshot({
    height: b1.height,
    blockHash: b1.hash,
    stateRoot: b1.stateRoot,
    ledger: snap.ledger,
    utxos: snap.utxos,
    partitions: {
      pools: snap.pools,
      validators: snap.validators,
      stakes: snap.stakes,
      difficulty: snap.difficulty,
      unbonding: snap.unbonding,
      contracts: snap.contracts,
    },
  });
  const loaded = await loadLatestSnapshot();
  if (!loaded || loaded.blockHash !== b1.hash || loaded.stateRoot !== root || loaded.partitions?.difficulty !== 1_200_000) {
    throw new Error("saveStateSnapshot did not leave the partitions");
  }

  const residual = canonicalResidual(
    {
      prevHash: b1.hash,
      merkleRoot: "00".repeat(32),
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: state.currentDifficulty,
    },
    [],
    { cumulativeWork: state.height + 1, mempoolPressure: 0 },
  );
  const before = {
    tipHash: b1.hash,
    height: state.height,
    stateRoot: root,
    difficulty: state.currentDifficulty,
    alice: state.ledger.balance(alice),
    miner: state.ledger.balance(miner),
    poolA: state.dexPools.get("EQU-USDC")!.reserveA,
    bond: state.validators.get(validator)!.bondedStake,
    stake: state.stakes.get(stakeKey)!.amount,
    residual,
  };
  const nextBlock = block(2, 1_700_000_016, b1.hash, state.currentDifficulty);
  state.addBlock(nextBlock);
  const after = {
    stateRoot: rebuildStateSmt(state).root(),
    difficulty: state.currentDifficulty,
    alice: state.ledger.balance(alice),
    miner: state.ledger.balance(miner),
    poolA: state.dexPools.get("EQU-USDC")!.reserveA,
    bond: state.validators.get(validator)!.bondedStake,
  };
  writeFileSync(reportPath, JSON.stringify({ before, nextBlock, after }));
  console.log(JSON.stringify({ wrote: true, before, after }));
  await closePersistence();
  process.exit(0);
}

async function readReport(): Promise<void> {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    before: {
      tipHash: string;
      height: number;
      stateRoot: string;
      difficulty: number;
      alice: number;
      miner: number;
      poolA: number;
      bond: number;
      stake: number;
      residual: number;
    };
    nextBlock: BlockRecord;
    after: {
      stateRoot: string;
      difficulty: number;
      alice: number;
      miner: number;
      poolA: number;
      bond: number;
    };
  };
  const chain = await import("../chain/index.js");
  await chain.initChain();
  await new Promise((resolve) => setTimeout(resolve, 500));
  const chainState = chain.chainState;
  const fails: string[] = [];
  const check = (name: string, got: unknown, expected: unknown) => {
    if (got !== expected) fails.push(`${name}: got ${String(got)} expected ${String(expected)}`);
  };
  check("height", chainState.height, report.before.height);
  check("tip", chainState.latestBlock?.hash, report.before.tipHash);
  check("difficulty", chainState.currentDifficulty, report.before.difficulty);
  check("alice", chainState.ledger.balance(alice), report.before.alice);
  check("miner", chainState.ledger.balance(miner), report.before.miner);
  check("pool", chainState.dexPools.get("EQU-USDC")?.reserveA, report.before.poolA);
  check("bond", chainState.validators.get(validator)?.bondedStake, report.before.bond);
  check("stake", chainState.stakes.get(stakeKey)?.amount, report.before.stake);
  const root = rebuildStateSmt(chainState).root();
  check("root", root, report.before.stateRoot);
  check("tipRoot", chainState.latestBlock?.stateRoot, report.before.stateRoot);
  const residual = canonicalResidual(
    {
      prevHash: report.before.tipHash,
      merkleRoot: "00".repeat(32),
      timestamp: 1_700_000_000,
      nonce: 6,
      difficulty: chainState.currentDifficulty,
    },
    [],
    { cumulativeWork: chainState.height + 1, mempoolPressure: 0 },
  );
  check("residual", residual, report.before.residual);
  chainState.addBlock({ ...report.nextBlock, transactions: report.nextBlock.transactions ?? [] });
  check("afterRoot", rebuildStateSmt(chainState).root(), report.after.stateRoot);
  check("afterDifficulty", chainState.currentDifficulty, report.after.difficulty);
  check("afterAlice", chainState.ledger.balance(alice), report.after.alice);
  check("afterMiner", chainState.ledger.balance(miner), report.after.miner);
  check("afterPool", chainState.dexPools.get("EQU-USDC")?.reserveA, report.after.poolA);
  check("afterBond", chainState.validators.get(validator)?.bondedStake, report.after.bond);
  if (fails.length > 0) {
    console.error(fails.join("\n"));
    await closePersistence();
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    height: chainState.height,
    root,
    residual,
    difficulty: report.before.difficulty,
    afterRoot: report.after.stateRoot,
    afterDifficulty: chainState.currentDifficulty,
  }));
  await closePersistence();
  process.exit(0);
}

const mode = process.argv[2];
if (mode === "write") {
  writeReport().catch(async (err) => {
    console.error(err);
    await closePersistence();
    process.exit(1);
  });
} else if (mode === "read") {
  readReport().catch(async (err) => {
    console.error(err);
    await closePersistence();
    process.exit(1);
  });
} else {
  console.error("usage: worker.ts write|read");
  process.exit(2);
}
