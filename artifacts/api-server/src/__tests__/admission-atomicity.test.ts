/**
 * Admission throws after Ω moves.
 * These are in-process injections. They do not restart the process, and they
 * do not walk HTTP, Stratum, or P2P. A failed restore is not a kept block.
 * Fields this picture does not read are not claimed.
 */
import { describe, expect, it } from "vitest";
import { ChainState, buildGenesisChainFromDoc } from "../chain/state.js";
import { kernelParty, KERNEL_ALLOCATIONS } from "../chain/kernel-genesis.js";
import { openedCouplings } from "../../../../site/src/protocol/constitution.js";
import { minerKey } from "../../../../site/src/protocol/genesis.js";
import type { Omega } from "../../../../site/src/protocol/types.js";
import type { BlockRecord } from "../chain/types.js";
import type { PersistBlockResult } from "../chain/persistence.js";

const miner = kernelParty("mainnet").miner;
const evidenceMiner = minerKey("mainnet").address;
const dirty = "dd".repeat(20);
const inserted: PersistBlockResult = { durable: true, outcome: "inserted" };

function genesis(): ChainState {
  return buildGenesisChainFromDoc({
    chain_id: "equilibrium-1",
    timestamp: "2026-07-05T00:44:37.417Z",
    initial_supply: "100000000",
    allocations: KERNEL_ALLOCATIONS.map((line) => ({
      address: line.address,
      amount: String(line.amount),
      vesting: "none",
      category: "line",
    })),
    initial_validators: [],
    dex_pools: [],
    parameters: {
      target_block_time_ms: 15_000,
      residual_threshold: 8e-4,
      initial_difficulty: 1_000_000,
      slashing_double_sign_pct: 5,
      slashing_downtime_pct: 1,
      unbonding_period_blocks: 10,
      max_validators: 100,
      governance_quorum_pct: 67,
      governance_voting_period_blocks: 10,
    },
  });
}

function seed(state: ChainState): void {
  state.validators.set(dirty, {
    address: dirty,
    moniker: "dirty",
    bondedStake: 1,
    accumulatedRewards: 0,
    slashed: false,
    slashCount: 0,
    jailed: false,
    uptime: 1,
    blocksProposed: 0,
    blocksVoted: 0,
    commission: 0,
  });
  state.dexPools.set("dirty-pool", {
    id: "dirty-pool",
    tokenA: "a",
    tokenB: "b",
    reserveA: 3,
    reserveB: 5,
    totalLiquidity: 1,
    fee: 1,
    volumeA: 0,
    volumeB: 0,
    txCount: 0,
    createdAt: 1,
  });
  state.stakes.set(`${dirty}-${dirty}`, {
    delegator: dirty,
    validator: dirty,
    amount: 4,
    startHeight: 0,
    startTimestamp: 1,
    unbonding: false,
    rewardsEarned: 0,
  });
  state.couplings = { ...state.couplings, fees: 2 };
  state.currentDifficulty = 42;
  state.finalizedHeight = 3;
  state.pendingUtxoFees = 7;
  state.unbondingQueue.push({
    delegator: dirty,
    validator: dirty,
    amount: 4,
    unbondingHeight: 1,
    completionHeight: 9,
  });
  state.kernelProposals.push({ id: "dirty-proposal", status: "open", couplingKey: "fees", couplingValue: 2 });
  state.canonicalWasm.set("dirty-key", "dirty-value");
  state.mempool.add({
    hash: "ab".repeat(32),
    from: dirty,
    to: "aa".repeat(20),
    amount: 1,
    fee: 1,
    nonce: 0,
    blockHash: null,
    blockHeight: null,
    timestamp: 1,
    status: "pending",
  });
  state.addressTxs.set(dirty, new Set(["ab".repeat(32)]));
  state.utxoSet.add({
    txHash: "cd".repeat(32),
    outputIndex: 0,
    address: dirty,
    amount: 5,
    coinbase: false,
    blockHeight: 0,
    spent: false,
  });
  state.txIndex.set("ef".repeat(32), {
    hash: "ef".repeat(32),
    from: dirty,
    to: dirty,
    amount: 2,
    fee: 0,
    nonce: 0,
    blockHash: null,
    blockHeight: null,
    timestamp: 1,
    status: "pending",
  });
}

function omegaPicture(omega: Omega) {
  return {
    chainId: omega.chainId,
    height: omega.height,
    tipHash: omega.tipHash,
    tipTimestamp: omega.tipTimestamp,
    difficulty: omega.difficulty,
    finalizedHeight: omega.finalizedHeight,
    couplings: { ...omega.couplings },
    ledger: [...omega.ledger.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([address, acc]) => ({ address, balance: acc.balance, nonce: acc.nonce })),
    pools: [...omega.pools]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((pool) => ({ ...pool })),
    validators: [...omega.validators.values()]
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      .map((validator) => ({ ...validator })),
    delegations: omega.delegations.map((row) => ({ ...row })),
    unbonding: omega.unbonding.map((row) => ({ ...row })),
    withdrawals: omega.withdrawals.map((row) => ({ ...row })),
    btc: omega.btc.map((row) => ({ ...row })),
    eth: omega.eth.map((row) => ({ ...row })),
    ethPubkey: omega.ethPubkey,
    ethCommittee: omega.ethCommittee ?? "",
    wasm: [...omega.wasm.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    proposals: omega.proposals.map((row) => ({ ...row })),
    models: omega.models.map((row) => ({ ...row })),
    settlements: omega.settlements.map((row) => ({ ...row })),
    ethExecution: (omega.ethExecution ?? []).map((row) => ({ ...row })),
  };
}

function picture(state: ChainState) {
  const raw = state as unknown as {
    preOmega: Map<number, Omega>;
    preOmegaBlocks: Map<number, Array<{ hash: string; height: number }>>;
    preBlockLedger: Map<number, Record<string, { balance: number; nonce: number }>>;
    preBlockValidators: Map<number, unknown[]>;
    preBlockStakes: Map<number, unknown[]>;
    preBlockPools: Map<number, unknown[]>;
    preBlockDifficulty: Map<number, number>;
    preBlockUnbonding: Map<number, unknown[]>;
    preBlockPendingFees: Map<number, number>;
    preBlockCouplings: Map<number, unknown>;
    preBlockWasm: Map<number, unknown>;
    preBlockProposals: Map<number, unknown[]>;
  };
  const keys = <T>(map: Map<number, T>) => [...map.keys()].sort((a, b) => a - b);
  return {
    omega: omegaPicture(state.canonicalBody.omega),
    canon: state.canonicalBody.blocks.map((block) => ({ hash: block.hash, height: block.height })),
    operational: state.blocks.map((block) => ({
      hash: block.hash,
      height: block.height,
      prevHash: block.prevHash,
      miner: block.miner,
      canonicalSuccessor: block.canonicalSuccessor ?? null,
      tx: block.transactions.map((tx) => tx.hash),
    })),
    height: state.height,
    retained: state.retainedBlocks.map((block) => block.hash),
    ledger: [...state.ledger.getAllAccounts().entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([address, acc]) => ({ address, balance: acc.balance, nonce: acc.nonce })),
    utxos: state.utxoSet.getAllUnspent()
      .map((utxo) => ({ ...utxo }))
      .sort((a, b) => (a.txHash + a.outputIndex < b.txHash + b.outputIndex ? -1 : 1)),
    txs: [...state.txIndex.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([hash, tx]) => ({ hash, status: tx.status, blockHash: tx.blockHash, blockHeight: tx.blockHeight, from: tx.from, to: tx.to, amount: tx.amount })),
    mempool: state.mempool.all().map((tx) => tx.hash).sort(),
    addresses: [...state.addressTxs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([addr, hashes]) => [addr, [...hashes].sort()]),
    validators: [...state.validators.values()]
      .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
      .map((validator) => ({ ...validator })),
    stakes: [...state.stakes.values()]
      .sort((a, b) => (a.delegator + a.validator < b.delegator + b.validator ? -1 : 1))
      .map((stake) => ({ ...stake })),
    pools: [...state.dexPools.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((pool) => ({ ...pool })),
    couplings: { ...state.couplings },
    difficulty: state.currentDifficulty,
    finalized: state.finalizedHeight,
    wasm: [...state.canonicalWasm.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    wasmHeight: (state.wasmVM as unknown as { blockHeight: number }).blockHeight,
    proposals: state.kernelProposals.map((row) => ({ ...row })),
    canonicalProposals: state.canonicalProposals.map((row) => ({ ...row })),
    models: state.canonicalModels.map((row) => ({ ...row })),
    settlements: state.canonicalSettlements.map((row) => ({ ...row })),
    btc: state.canonicalBtc.map((row) => ({ ...row })),
    eth: state.canonicalEth.map((row) => ({ ...row })),
    btcTip: state.btcTipHash,
    ethTip: state.admittedEthTip,
    rounds: [...state.finalityRounds.entries()].sort((a, b) => a[0] - b[0]),
    stats: state.blockStats.map((row) => ({ ...row })),
    fees: state.pendingUtxoFees,
    unbonding: state.unbondingQueue.map((row) => ({ ...row })),
    preHeights: keys(raw.preOmega),
    preOmega: keys(raw.preOmega).map((height) => [height, omegaPicture(raw.preOmega.get(height)!)]),
    preCanon: keys(raw.preOmegaBlocks).map((height) => [height, raw.preOmegaBlocks.get(height)!.map((block) => block.hash)]),
    preLedger: keys(raw.preBlockLedger).map((height) => [height, raw.preBlockLedger.get(height)]),
    preValidators: keys(raw.preBlockValidators).map((height) => [height, raw.preBlockValidators.get(height)!.length]),
    preStakes: keys(raw.preBlockStakes).map((height) => [height, raw.preBlockStakes.get(height)!.length]),
    prePools: keys(raw.preBlockPools).map((height) => [height, raw.preBlockPools.get(height)!.length]),
    preDifficulty: keys(raw.preBlockDifficulty).map((height) => [height, raw.preBlockDifficulty.get(height)]),
    preUnbonding: keys(raw.preBlockUnbonding).map((height) => [height, raw.preBlockUnbonding.get(height)!.length]),
    preFees: keys(raw.preBlockPendingFees).map((height) => [height, raw.preBlockPendingFees.get(height)]),
    preCouplings: keys(raw.preBlockCouplings).map((height) => [height, raw.preBlockCouplings.get(height)]),
    preWasm: keys(raw.preBlockWasm).map((height) => [height, raw.preBlockWasm.get(height)]),
    preProposals: keys(raw.preBlockProposals).map((height) => [height, raw.preBlockProposals.get(height)!.length]),
  };
}

function bodiesAgree(state: ChainState): boolean {
  const omega = state.canonicalBody.omega;
  const tip = state.blocks[state.blocks.length - 1];
  if (!tip || tip.hash !== omega.tipHash || tip.height !== omega.height) return false;
  if (state.height !== omega.height) return false;
  if (state.canonicalBody.blocks.at(-1)?.hash !== omega.tipHash) return false;
  if (state.currentDifficulty !== omega.difficulty) return false;
  if (state.finalizedHeight !== omega.finalizedHeight) return false;
  if ((state.wasmVM as unknown as { blockHeight: number }).blockHeight !== omega.height) return false;
  const ledger = new Map([...state.ledger.getAllAccounts().entries()].map(([addr, acc]) => [addr, `${acc.balance}:${acc.nonce}`]));
  for (const [addr, acc] of omega.ledger) {
    if (ledger.get(addr) !== `${acc.balance}:${acc.nonce}`) return false;
    ledger.delete(addr);
  }
  if (ledger.size !== 0) return false;
  if (state.validators.size !== omega.validators.size) return false;
  for (const validator of omega.validators.values()) {
    const operational = state.validators.get(validator.address);
    if (!operational) return false;
    if (operational.bondedStake !== validator.bondedStake || operational.jailed !== validator.jailed || operational.slashed !== validator.slashed) return false;
  }
  if (state.dexPools.size !== omega.pools.length) return false;
  for (const pool of omega.pools) {
    const operational = state.dexPools.get(pool.id);
    if (!operational || operational.reserveA !== pool.reserveA || operational.reserveB !== pool.reserveB) return false;
  }
  for (const [key, value] of omega.wasm) {
    if (state.canonicalWasm.get(key) !== value) return false;
  }
  if (state.canonicalWasm.size !== omega.wasm.size) return false;
  return state.couplings.hash === omega.couplings.hash
    && state.couplings.structural === omega.couplings.structural
    && state.couplings.continuity === omega.couplings.continuity
    && state.couplings.mempool === omega.couplings.mempool
    && state.couplings.fees === omega.couplings.fees;
}

function candidate(state: ChainState, nonce: number, timestamp: number): BlockRecord {
  const omega = state.canonicalBody.omega;
  return {
    hash: "11".repeat(32),
    height: omega.height + 1,
    prevHash: omega.tipHash,
    merkleRoot: "0".repeat(64),
    timestamp,
    nonce,
    difficulty: omega.difficulty,
    residual: 1e-9,
    recursionDepth: 2,
    coinbaseReward: 0,
    miner,
    txCount: 0,
    transactions: [],
    committedPressure: 0,
  };
}

function evidenceInputs(omega: Omega, nonce: bigint, timestamp: number) {
  return {
    transactions: [] as BlockRecord["transactions"],
    timestamp,
    nonce,
    miner: evidenceMiner,
    committedPressure: 0,
    couplings: openedCouplings(omega),
    difficulty: omega.difficulty,
  };
}

function patch(state: ChainState, name: string, fn: unknown): () => void {
  const host = state as unknown as Record<string, unknown>;
  host[name] = fn;
  return () => {
    delete host[name];
  };
}

function original(state: ChainState, name: string) {
  return Object.getPrototypeOf(state)[name] as (this: ChainState, ...args: unknown[]) => unknown;
}

describe("a throw after Ω moves does not leave the operational body behind", () => {
  it("a non-successor still refuses with the same error and does not move", () => {
    const state = genesis();
    seed(state);
    const before = picture(state);
    const block = candidate(state, 6, 1_700_000_000);
    block.prevHash = "1".repeat(64);
    expect(() => state.addBlock(block)).toThrow(/^block is not the successor$/);
    expect(picture(state)).toEqual(before);
  });

  it("OP-1 throws after noteBefore and the next successor does not inherit the split", async () => {
    const state = genesis();
    seed(state);
    const before = picture(state);
    let omegaDuring = -99;
    let blocksDuring = -99;
    const undo = patch(state, "noteBefore", function (this: ChainState, ...args: unknown[]) {
      original(state, "noteBefore").apply(this, args);
      omegaDuring = this.canonicalBody.omega.height;
      blocksDuring = this.blocks.length;
      throw new Error("injected after noteBefore");
    });
    const outcome = await state.commitOperational(candidate(state, 6, 1_700_000_000), {
      persist: async () => inserted,
    });
    undo();
    expect(omegaDuring).toBe(before.omega.height + 1);
    expect(blocksDuring).toBe(before.operational.length);
    expect(outcome).toMatchObject({ admitted: false, kept: false, persist: null, error: "injected after noteBefore" });
    expect(picture(state)).toEqual(before);
    const next = await state.commitOperational(candidate(state, 9, 1_700_000_100), {
      persist: async () => inserted,
    });
    expect(next.kept).toBe(true);
    expect(next.admitted).toBe(true);
    expect(bodiesAgree(state)).toBe(true);
    expect(state.validators.has(dirty)).toBe(false);
    expect(state.dexPools.has("dirty-pool")).toBe(false);
  });

  it("OP-2 throws at the start of embodiment and restores the prior picture", async () => {
    const state = genesis();
    seed(state);
    const before = picture(state);
    let omegaDuring = -99;
    let blocksDuring = -99;
    let dirtyDuring = false;
    const undo = patch(state, "embodyCanonical", function (this: ChainState) {
      omegaDuring = this.canonicalBody.omega.height;
      blocksDuring = this.blocks.length;
      dirtyDuring = this.validators.has(dirty) && this.dexPools.has("dirty-pool");
      throw new Error("injected at embodyCanonical");
    });
    const outcome = await state.commitOperational(candidate(state, 6, 1_700_000_000), {
      persist: async () => inserted,
    });
    undo();
    expect(omegaDuring).toBe(before.omega.height + 1);
    expect(blocksDuring).toBe(before.operational.length + 1);
    expect(dirtyDuring).toBe(true);
    expect(outcome).toMatchObject({ admitted: false, kept: false, persist: null, error: "injected at embodyCanonical" });
    expect(picture(state)).toEqual(before);
    const next = await state.commitOperational(candidate(state, 9, 1_700_000_100), {
      persist: async () => inserted,
    });
    expect(next.kept).toBe(true);
    expect(bodiesAgree(state)).toBe(true);
  });

  it("OP-3 throws after the ledger projection and restores validators and pools", async () => {
    const state = genesis();
    seed(state);
    const before = picture(state);
    const beforeOmega = JSON.stringify(before.omega);
    let omegaDuring = beforeOmega;
    let dirtyDuring = false;
    let blocksDuring = -99;
    const undo = patch(state, "projectLedger", function (this: ChainState) {
      original(state, "projectLedger").call(this);
      omegaDuring = JSON.stringify(omegaPicture(this.canonicalBody.omega));
      dirtyDuring = this.validators.has(dirty) && this.dexPools.has("dirty-pool");
      blocksDuring = this.blocks.length;
      throw new Error("injected after projectLedger");
    });
    const outcome = await state.commitOperational(candidate(state, 6, 1_700_000_000), {
      persist: async () => inserted,
    });
    undo();
    expect(blocksDuring).toBe(before.operational.length + 1);
    expect(omegaDuring).not.toBe(beforeOmega);
    expect(dirtyDuring).toBe(true);
    expect(outcome).toMatchObject({ admitted: false, kept: false, persist: null, error: "injected after projectLedger" });
    expect(picture(state)).toEqual(before);
    expect(state.validators.get(dirty)?.moniker).toBe("dirty");
    expect(state.dexPools.get("dirty-pool")?.reserveA).toBe(3);
    const next = await state.commitOperational(candidate(state, 9, 1_700_000_100), {
      persist: async () => inserted,
    });
    expect(next.kept).toBe(true);
    expect(bodiesAgree(state)).toBe(true);
    expect(state.validators.has(dirty)).toBe(false);
    expect(state.dexPools.has("dirty-pool")).toBe(false);
  });

  it("EV-1 throws after evidence noteBefore and the refusal stays inside the queue", async () => {
    const state = new ChainState();
    seed(state);
    const before = picture(state);
    let omegaDuring = -99;
    let blocksDuring = -99;
    const undo = patch(state, "noteBefore", function (this: ChainState, ...args: unknown[]) {
      original(state, "noteBefore").apply(this, args);
      omegaDuring = this.canonicalBody.omega.height;
      blocksDuring = this.blocks.length;
      throw new Error("injected after noteBefore");
    });
    const outcome = await state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 1n, 1_700_000_000));
    undo();
    expect(omegaDuring).toBe(before.omega.height + 1);
    expect(blocksDuring).toBe(before.operational.length);
    expect(outcome).toMatchObject({ admitted: false, kept: false, persist: null, error: "injected after noteBefore" });
    expect(picture(state)).toEqual(before);
    const next = await state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 2n, 1_700_000_100), {
      persist: async () => inserted,
    });
    expect(next.kept).toBe(true);
    expect(bodiesAgree(state)).toBe(true);
  });

  it("EV-2 throws after the evidence ledger projection and records both bodies restored", async () => {
    const state = new ChainState();
    seed(state);
    const before = picture(state);
    const beforeLedger = JSON.stringify(before.ledger);
    let ledgerDuring = beforeLedger;
    const undo = patch(state, "projectLedger", function (this: ChainState) {
      original(state, "projectLedger").call(this);
      ledgerDuring = JSON.stringify(picture(this).ledger);
      throw new Error("injected after projectLedger");
    });
    const outcome = await state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 3n, 1_700_000_000));
    undo();
    expect(ledgerDuring).not.toBe(beforeLedger);
    expect(outcome).toMatchObject({ admitted: false, kept: false, persist: null, error: "injected after projectLedger" });
    expect(picture(state)).toEqual(before);
    expect(state.validators.get(dirty)?.moniker).toBe("dirty");
    expect(state.dexPools.get("dirty-pool")?.reserveB).toBe(5);
    const next = await state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 4n, 1_700_000_100), {
      persist: async () => inserted,
    });
    expect(next.kept).toBe(true);
    expect(bodiesAgree(state)).toBe(true);
    expect(state.validators.has(dirty)).toBe(false);
  });

  it("REC-1 keeps the original failure when restore throws, and does not report success", async () => {
    const state = genesis();
    seed(state);
    const before = picture(state);
    const undoNote = patch(state, "noteBefore", function (this: ChainState, ...args: unknown[]) {
      original(state, "noteBefore").apply(this, args);
      throw new Error("injected after noteBefore");
    });
    const undoRestore = patch(state, "restoreTemporal", function () {
      throw new Error("restore exploded");
    });
    const outcome = await state.commitOperational(candidate(state, 6, 1_700_000_000), {
      persist: async () => inserted,
    });
    undoNote();
    undoRestore();
    expect(outcome.admitted).toBe(false);
    expect(outcome.kept).toBe(false);
    expect(outcome.persist).toBeNull();
    expect(outcome.error).toBe("admission failed: injected after noteBefore; restore failed: restore exploded");
    const diverged = picture(state);
    expect(diverged).not.toEqual(before);
    expect(diverged.omega.height).toBe(before.omega.height + 1);
    expect(diverged.operational).toEqual(before.operational);
    expect(diverged.canon).toHaveLength(before.canon.length + 1);
    expect(diverged.preHeights).toContain(before.omega.height + 1);
    expect(diverged.wasmHeight).toBe(before.wasmHeight);

    const stale = candidate(state, 11, 1_700_000_500);
    stale.prevHash = before.omega.tipHash;
    stale.height = before.omega.height + 1;
    stale.difficulty = before.omega.difficulty;
    const refused = await state.commitOperational(stale, { persist: async () => inserted });
    expect(refused).toMatchObject({ admitted: false, kept: false, persist: null, error: "block is not the successor" });
    expect(picture(state)).toEqual(diverged);
  });

  it("REC-1 on evidence also preserves both failures and does not keep the block", async () => {
    const state = new ChainState();
    seed(state);
    const before = picture(state);
    const undoNote = patch(state, "noteBefore", function (this: ChainState, ...args: unknown[]) {
      original(state, "noteBefore").apply(this, args);
      throw new Error("injected after noteBefore");
    });
    const undoRestore = patch(state, "restoreTemporal", function () {
      throw new Error("restore exploded");
    });
    const outcome = await state.commitEvidence(evidenceInputs(state.canonicalBody.omega, 5n, 1_700_000_000));
    undoNote();
    undoRestore();
    expect(outcome.admitted).toBe(false);
    expect(outcome.kept).toBe(false);
    expect(outcome.persist).toBeNull();
    expect(outcome.error).toBe("admission failed: injected after noteBefore; restore failed: restore exploded");
    const diverged = picture(state);
    expect(diverged).not.toEqual(before);
    expect(diverged.omega.height).toBe(before.omega.height + 1);
    expect(diverged.operational).toEqual(before.operational);
    expect(diverged.canon).toHaveLength(before.canon.length + 1);
    expect(diverged.preHeights).toContain(before.omega.height + 1);
  });
});
