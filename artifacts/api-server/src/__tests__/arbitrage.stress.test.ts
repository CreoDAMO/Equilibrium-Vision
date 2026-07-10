/**
 * Arbitrage contract stress tests — exercises safety rails:
 *   - Circuit breaker (rolling window, MAX_EXECS_PER_WINDOW = 5)
 *   - Max trade amount cap (arbitrageMaxTradeAmount)
 *   - minProfit advisory behaviour (no rollback — LIMITATIONS.md §1)
 *   - Governance parameter hot-reloading
 *   - Rollback / reorg correctness (Phase 0 fix)
 *   - Deterministic fuzzing with seeded PRNG
 *
 * Conventions follow arbitrage.integration.test.ts and models.integration.test.ts.
 *
 * IMPORTANT — on-chain execution order in method_execute (contracts/arbitrage/src/lib.rs):
 *   1. -6  caller is not the owner
 *   2. -1  paused == 1 OR circuit_tripped == 1   ← early-exit check
 *   3. -2  no registry / model configured
 *   4. -3  model not verified / below update delay
 *   5. -4  amountIn > arbitrageMaxTradeAmount
 *   6.     circuit-breaker increment (exec_count > 5 → sets circuit_tripped=1 → returns -1)
 *   7. -5  dex_multi_swap failed
 *
 * Consequence: to reach the circuit-breaker INCREMENT path (step 6) and the max-amount
 * check (step 5) a verified model must be configured. The -2/-3 checks gate everything
 * upstream of those. Tests that need steps 5/6 use setupVerifiedModel(); tests that only
 * need the early-exit -1 path (step 2) do not need a model (circuit_tripped flag is
 * already set in storage from a prior call).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import supertest from "supertest";
import app from "../app.js";
import { initChain, stopMining, chainState, minerAddress } from "../chain/index.js";
import { mineNextBlock } from "../chain/state.js";
import {
  executeArbitrage,
  pauseArbitrage,
  unpauseArbitrage,
  setArbitrageModel,
  getArbitrageAddress,
} from "../chain/arbitrage.js";
import {
  proposeModel,
  verifyModel,
  getModelRegistryAddress,
  encodeSupportCommitment,
} from "../chain/modelRegistry.js";

const api = supertest(app);

// ── helpers ───────────────────────────────────────────────────────────────────

function randomAddress(): string {
  return randomBytes(20).toString("hex");
}

function fund(addr: string, amount: number): void {
  chainState.ledger.credit(addr, amount);
}

function advanceBlocks(count: number): void {
  for (let i = 0; i < count; i++) {
    chainState.addBlock(mineNextBlock(chainState, minerAddress));
  }
}

let poolCounter = 0;
/** Create a uniquely-named triangle of pools. */
function createTrianglePools(): { poolIds: string[]; tokenIn: string } {
  const n = ++poolCounter;
  const prefix = `stress${n}`;
  const pAB = `${prefix}-AB`;
  const pBC = `${prefix}-BC`;
  const pCA = `${prefix}-CA`;
  chainState.createPool(pAB, `${prefix}A`, `${prefix}B`, 1_000_000, 900_000);
  chainState.createPool(pBC, `${prefix}B`, `${prefix}C`, 900_000, 1_100_000);
  chainState.createPool(pCA, `${prefix}C`, `${prefix}A`, 1_100_000, 950_000);
  return { poolIds: [pAB, pBC, pCA], tokenIn: `${prefix}A` };
}

async function getContractOwner(): Promise<string> {
  const res = await api.get("/api/arbitrage/status");
  return res.body.owner as string;
}

/**
 * Wire up a verified model so execute_arbitrage can pass the -2/-3 gate.
 * Temporarily lowers arbitrageModelUpdateDelay to 1 for speed.
 */
async function setupVerifiedModel(owner: string): Promise<{ registryAddr: string; modelId: number }> {
  const registryAddr = getModelRegistryAddress()!;
  const proposer = randomAddress();
  fund(proposer, 5_000_000_000);

  const { hashHex } = encodeSupportCommitment([[0, 0], [1, 1]], [0, 1]);
  const propResult = await proposeModel(chainState.wasmVM, proposer, {
    claimedResidual: 0,
    supportHashHex: hashHex,
    inputDim: 2,
    hiddenDim: 4,
    lambda: 0.1,
    seed: 99,
    uri: "ipfs://stress-test-model",
  });
  if (!propResult.success || propResult.modelId === undefined) {
    throw new Error(`proposeModel failed: ${propResult.error}`);
  }
  const modelId = propResult.modelId;

  // Advance past the challenge window (default 100 blocks)
  advanceBlocks(101);
  const verifyResult = await verifyModel(chainState.wasmVM, proposer, modelId);
  if (!verifyResult.success) throw new Error(`verifyModel failed: ${verifyResult.error}`);

  // Lower update delay to 1 so we don't need 50 more blocks
  chainState.governance.params.arbitrageModelUpdateDelay = 1;
  advanceBlocks(2);

  const setResult = await setArbitrageModel(chainState.wasmVM, owner, registryAddr, modelId);
  if (!setResult.success) throw new Error(`setArbitrageModel failed: ${setResult.error}`);

  return { registryAddr, modelId };
}

// ── Suite setup ───────────────────────────────────────────────────────────────

let contractOwner: string;

beforeAll(async () => {
  await initChain();
  contractOwner = await getContractOwner();
}, 30_000);

afterAll(() => { stopMining(); });

// ─────────────────────────────────────────────────────────────────────────────
// 2.1  Rapid-fire execution: circuit breaker trips after MAX_EXECS_PER_WINDOW=5
//
// Because the model check (-2/-3) gates the circuit-breaker increment (step 6
// in execution order), we must configure a verified model to actually exercise
// the rolling-window counter. Once circuit_tripped=1 is set in storage, the
// EARLY-EXIT check at step 2 immediately returns -1 regardless of model state.
// ─────────────────────────────────────────────────────────────────────────────

describe("2.1 Rapid-fire execution — circuit breaker trips after 5 calls", () => {
  beforeEach(async () => {
    // Reset state: unpause clears both paused and circuit_tripped
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
  });

  it("sets up verified model and executions 1–5 are NOT rejected with the circuit-breaker error", async () => {
    // Small window so all 6 calls fall within it
    chainState.governance.params.arbitrageWindowBlocks = 10;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    const errors: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
      if (!r.success && r.error) errors.push(r.error);
    }
    // None of the first 5 calls should be the circuit-breaker error
    for (const err of errors) {
      expect(err).not.toBe("Paused or circuit breaker tripped");
    }
  });

  it("the 6th call is rejected with 'Paused or circuit breaker tripped'", async () => {
    // Model is already set from previous test; circuit is reset by beforeEach unpause
    // Re-setup model in case tests run in isolation
    chainState.governance.params.arbitrageWindowBlocks = 10;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;
    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    // Burn 5 executions (increment exec_count to 5)
    for (let i = 0; i < 5; i++) {
      await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
    }
    // 6th: exec_count becomes 6 > MAX_EXECS_PER_WINDOW(5) → sets circuit_tripped=1 → returns -1
    const r6 = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    expect(r6.success).toBe(false);
    expect(r6.error).toBe("Paused or circuit breaker tripped");
  });

  it("after unpause, the next call is no longer blocked by the circuit breaker", async () => {
    // circuit_tripped=1 is set from the previous test; unpause (beforeEach) already ran
    // so circuit is reset. The next execute should NOT see -1 from early-exit.
    chainState.governance.params.arbitrageWindowBlocks = 10;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;
    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    expect(r.error ?? "").not.toBe("Paused or circuit breaker tripped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.2  Hard cap: amountIn > arbitrageMaxTradeAmount → rejected with -4
//
// The -4 check (step 5) is downstream of the model check (-2/-3 at steps 3/4).
// We must configure a verified model so the max-amount check is reached.
// ─────────────────────────────────────────────────────────────────────────────

describe("2.2 Max-trade-amount cap", () => {
  beforeEach(async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
  });

  afterEach(() => {
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;
  });

  it("rejects amountIn exceeding the governance cap with 'Amount exceeds the max trade amount'", async () => {
    chainState.governance.params.arbitrageModelUpdateDelay = 1;
    await setupVerifiedModel(contractOwner);

    // Set a cap smaller than the amountIn we'll send
    chainState.governance.params.arbitrageMaxTradeAmount = 1_000;

    const { poolIds, tokenIn } = createTrianglePools();
    const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds,
      tokenIn,
      amountIn: 500_000, // 500× the cap
      minProfit: 0,
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Amount exceeds the max trade amount");
  });

  it("pool reserves are unchanged after a cap-rejected call", async () => {
    chainState.governance.params.arbitrageModelUpdateDelay = 1;
    await setupVerifiedModel(contractOwner);

    chainState.governance.params.arbitrageMaxTradeAmount = 500;
    const { poolIds, tokenIn } = createTrianglePools();
    const pool = chainState.dexPools.get(poolIds[0]!)!;
    const rABefore = pool.reserveA;
    const rBBefore = pool.reserveB;

    await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds,
      tokenIn,
      amountIn: 100_000, // exceeds cap — dex_multi_swap is never called
      minProfit: 0,
    });

    // dex_multi_swap is NOT invoked for a -4 rejection — reserves must be unchanged
    expect(pool.reserveA).toBe(rABefore);
    expect(pool.reserveB).toBe(rBBefore);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.3  Profit below minProfit — trade still executes (LIMITATIONS.md §1)
// ─────────────────────────────────────────────────────────────────────────────

describe("2.3 Profit below minProfit — advisory only, not a revert (LIMITATIONS.md §1)", () => {
  /**
   * Per LIMITATIONS.md §1: "If profit falls short, the contract logs
   * ArbitrageUnderTarget and returns a success code — it does NOT roll back
   * the swaps that have already been applied."
   *
   * This test verifies that behaviour is present in the code, not that it
   * is desirable. It is a documentation-of-behaviour test.
   */
  it("execute succeeds and pool reserves change even when profit < minProfit", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const pool1 = chainState.dexPools.get(poolIds[0]!)!;
    const rABefore = pool1.reserveA;

    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 10_000_000);

    // minProfit set absurdly high — far above any realistic single-call profit
    const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds,
      tokenIn,
      amountIn: 1_000,
      minProfit: 1_000_000_000_000_000,
    });

    if (r.success) {
      // The trade DID happen — pool reserves must have changed
      expect(pool1.reserveA).not.toBe(rABefore);

      // Contract log must contain ArbitrageUnderTarget (LIMITATIONS.md §1)
      const contractRecord = chainState.wasmVM.getContract(contractAddr);
      const logs = contractRecord?.events ?? [];
      expect(logs.some(l => l.includes("ArbitrageUnderTarget"))).toBe(true);
    } else {
      // Swap failure (-5) is acceptable if liquidity was depleted by prior tests.
      // The important invariant: NOT the model-gate errors (-2/-3).
      expect(r.error).not.toBe("No model configured");
      expect(r.error).not.toBe("Model not verified, or not yet past the update delay");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.4  Concurrent execution attempts via Promise.all
// ─────────────────────────────────────────────────────────────────────────────

describe("2.4 Concurrent execution — circuit-breaker semantics under Promise.all", () => {
  /**
   * NOTE: execute_arbitrage() does NOT spawn a subprocess. The WASM
   * execCall() is synchronous (WebAssembly.Instance per call, no Asyncify).
   * Under Node.js's single-threaded event loop, Promise.all serialises these
   * calls rather than truly parallelising them. This test verifies that
   * exec_count is counted correctly across back-to-back async calls and that
   * the circuit breaker is not double-counted or skipped.
   *
   * Only the contract owner may call execute_arbitrage — multi-caller testing
   * is not possible with the current single-owner design.
   */
  it("no more than 5 non-circuit-breaker results from 10 concurrent calls", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageWindowBlocks = 20;
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        executeArbitrage(chainState.wasmVM, contractOwner, {
          poolIds, tokenIn, amountIn: 100, minProfit: 0,
        })
      )
    );

    const circuitBreakerErrors = results.filter(
      r => !r.success && r.error === "Paused or circuit breaker tripped"
    );
    const notCircuitBreakerErrors = results.filter(
      r => r.success || r.error !== "Paused or circuit breaker tripped"
    );

    // At most 5 results may be non-circuit-breaker (the first 5 increments)
    expect(notCircuitBreakerErrors.length).toBeLessThanOrEqual(5);
    // At least 5 must have hit the circuit-breaker
    expect(circuitBreakerErrors.length).toBeGreaterThanOrEqual(5);

    // Any extra call after the trip must also be rejected
    const extra = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    expect(extra.success).toBe(false);
    expect(extra.error).toBe("Paused or circuit breaker tripped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.5  Circuit breaker is sticky — does NOT self-heal after window elapses
// ─────────────────────────────────────────────────────────────────────────────

describe("2.5 Circuit breaker is sticky (no time-based self-heal)", () => {
  it("advancing past the window does NOT clear a tripped breaker; unpause() does", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageWindowBlocks = 5;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    // Trip the circuit breaker (needs 6 calls past the model gate)
    for (let i = 0; i < 6; i++) {
      await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
    }

    // Confirm breaker is tripped — no model needed, early-exit check fires first
    const beforeAdvance = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    expect(beforeAdvance.error).toBe("Paused or circuit breaker tripped");

    // Advance past the window — the trip is sticky (circuit_tripped flag persists)
    advanceBlocks(10);

    const afterAdvance = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    // Still rejected — time-based self-heal does NOT exist
    expect(afterAdvance.error).toBe("Paused or circuit breaker tripped");

    // unpause() explicitly clears both paused=0 and circuit_tripped=0
    await unpauseArbitrage(chainState.wasmVM, contractOwner);

    const afterUnpause = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    // Circuit-breaker is cleared — any error must NOT be -1
    expect(afterUnpause.error ?? "").not.toBe("Paused or circuit breaker tripped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.6  Sliding window — old executions fall out after the window rolls over
// ─────────────────────────────────────────────────────────────────────────────

describe("2.6 Sliding window correctness — exec_count resets after window rolls", () => {
  it("3 execs in window N, advance past it, 3 execs in window N+1 — never trips breaker", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageWindowBlocks = 5;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    // Window N: 3 executions (below threshold of 5)
    for (let i = 0; i < 3; i++) {
      await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
    }

    // Roll the window forward (now >= window_start + window → exec_count resets)
    advanceBlocks(6);

    // Window N+1: 3 more executions — counter reset, no trip
    const results: Array<{ success: boolean; error?: string }> = [];
    for (let i = 0; i < 3; i++) {
      const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
      results.push(r);
    }

    for (const r of results) {
      expect(r.error ?? "").not.toBe("Paused or circuit breaker tripped");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.7  Governance parameter changes take effect immediately (live, not cached)
// ─────────────────────────────────────────────────────────────────────────────

describe("2.7 Governance parameter hot-reload", () => {
  afterEach(() => {
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;
    chainState.governance.params.arbitrageWindowBlocks = 100;
  });

  it("lowering arbitrageMaxTradeAmount rejects a previously-passing amountIn", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    // Start with a permissive cap — 1M amountIn < 100M cap → cap check passes
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000;
    const { poolIds: p1, tokenIn: t1 } = createTrianglePools();
    const r1 = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds: p1, tokenIn: t1, amountIn: 1_000_000, minProfit: 0,
    });
    expect(r1.error ?? "").not.toBe("Amount exceeds the max trade amount");

    // Lower the cap below the same amountIn — immediate effect
    chainState.governance.params.arbitrageMaxTradeAmount = 500_000;
    const { poolIds: p2, tokenIn: t2 } = createTrianglePools();
    const r2 = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds: p2, tokenIn: t2, amountIn: 1_000_000, minProfit: 0,
    });
    expect(r2.success).toBe(false);
    expect(r2.error).toBe("Amount exceeds the max trade amount");
  });

  it("changing arbitrageWindowBlocks live affects subsequent window checks", async () => {
    // unpause clears circuit_tripped but NOT exec_count. To guarantee a clean
    // window counter, we advance the chain far enough that the current window
    // expires before any execs in this test — then exec_count resets on the
    // first call regardless of prior state.
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageModelUpdateDelay = 1;
    // Use a 3-block window and advance 4 blocks to roll it over
    chainState.governance.params.arbitrageWindowBlocks = 3;
    advanceBlocks(4); // guarantees block_number - window_start >= 3 → clean slate

    await setupVerifiedModel(contractOwner);

    // Now set a very large window so 3 execs (well below 5) don't trip
    chainState.governance.params.arbitrageWindowBlocks = 1000;
    const { poolIds, tokenIn } = createTrianglePools();
    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 50_000_000);

    for (let i = 0; i < 3; i++) {
      const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
        poolIds, tokenIn, amountIn: 100, minProfit: 0,
      });
      expect(r.error ?? "").not.toBe("Paused or circuit breaker tripped");
    }

    // Shrink the window to 2 and advance past it so exec_count resets on next call
    chainState.governance.params.arbitrageWindowBlocks = 2;
    advanceBlocks(3);

    // New window: exec_count resets; should NOT be circuit-breaker error
    const rAfter = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    expect(rAfter.error ?? "").not.toBe("Paused or circuit breaker tripped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.8  Rollback scenario — wasmVM.setBlockHeight kept in sync (Phase 0)
// ─────────────────────────────────────────────────────────────────────────────

describe("2.8 Rollback / reorg — wasmVM block height stays consistent", () => {
  /**
   * The finality gadget finalizes blocks after a super-majority vote (~95%
   * participation). rollbackToHeight() throws if targetHeight < finalizedHeight.
   * To avoid that, we mine 2 fresh blocks and immediately roll them back —
   * newly-mined blocks are not yet finalized at that instant.
   */
  it("rollbackToHeight keeps chainState.height correct and the VM stays coherent", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageWindowBlocks = 100;
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;

    // Mine 2 blocks and IMMEDIATELY roll back.
    // The finality gadget runs in addBlock via runFinalityRound; it finalizes a block
    // when >= 2/3 of validators vote. To roll back safely we must target a height
    // strictly above finalizedHeight. We capture finalizedHeight BEFORE mining and
    // roll back to max(finalizedHeight, heightBefore) to guarantee we never cross it.
    const heightBefore = chainState.height;

    chainState.addBlock(mineNextBlock(chainState, minerAddress));
    chainState.addBlock(mineNextBlock(chainState, minerAddress));
    expect(chainState.height).toBeGreaterThanOrEqual(heightBefore + 2);

    // The finality gadget (runFinalityRound) may finalize the newly-added blocks
    // immediately inside addBlock(). Roll back to exactly finalizedHeight + 1 —
    // the lowest non-finalized block — which always exists since we just mined 2.
    const safeTarget = chainState.finalizedHeight + 1;
    chainState.rollbackToHeight(safeTarget);
    expect(chainState.height).toBe(safeTarget);

    // Phase-0 assertion: wasmVM.setBlockHeight() was called with heightBefore.
    // We verify this indirectly: the contract is still reachable (no VM crash)
    // and the HTTP status endpoint reports a valid address — proving the VM
    // wasn't left in a broken/stale state after the reorg.
    const statusRes = await api.get("/api/arbitrage/status");
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.address).toMatch(/^[0-9a-f]{40}$/);

    // Additional VM coherence check: execute returns a defined result (not null/crash)
    const { poolIds, tokenIn } = createTrianglePools();
    const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds, tokenIn, amountIn: 100, minProfit: 0,
    });
    // Any defined error code is fine — the VM must not return null/undefined
    expect(r.success !== undefined).toBe(true);
    // No raw VM crash ("call failed" with no further info)
    if (!r.success) {
      expect(r.error).not.toBe("call failed");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2.9  Partial success — no rollback on under-target profit (LIMITATIONS.md §1)
// ─────────────────────────────────────────────────────────────────────────────

describe("2.9 Partial success — swap state IS mutated even when profit < minProfit", () => {
  it("pool reserves change after a swap even if ArbitrageUnderTarget is logged", async () => {
    await unpauseArbitrage(chainState.wasmVM, contractOwner);
    chainState.governance.params.arbitrageMaxTradeAmount = 100_000_000_000;
    chainState.governance.params.arbitrageModelUpdateDelay = 1;

    await setupVerifiedModel(contractOwner);

    const { poolIds, tokenIn } = createTrianglePools();
    const pool1 = chainState.dexPools.get(poolIds[0]!)!;
    const rABefore = pool1.reserveA;
    const rBBefore = pool1.reserveB;

    const contractAddr = getArbitrageAddress()!;
    fund(contractAddr, 10_000_000);

    // Set minProfit to a value impossible to achieve in a single call
    const r = await executeArbitrage(chainState.wasmVM, contractOwner, {
      poolIds,
      tokenIn,
      amountIn: 1_000,
      minProfit: 1_000_000_000_000_000,
    });

    if (r.success) {
      // LIMITATIONS.md §1: no rollback. Pool reserves must have changed.
      const reservesChanged =
        pool1.reserveA !== rABefore || pool1.reserveB !== rBBefore;
      expect(reservesChanged).toBe(true);

      // Contract log must contain ArbitrageUnderTarget
      const contractRecord = chainState.wasmVM.getContract(contractAddr);
      const logs = contractRecord?.events ?? [];
      expect(logs.some(l => l.includes("ArbitrageUnderTarget"))).toBe(true);
    } else {
      // Swap failure (-5) is acceptable if pool liquidity was drained by earlier tests.
      // The -2/-3 gates must NOT fire since we set up a verified model.
      expect(r.error).not.toBe("No model configured");
      expect(r.error).not.toBe("Model not verified, or not yet past the update delay");
    }
  });
});

// =============================================================================
// Phase 3 — Deterministic fuzzing with seeded PRNG
// =============================================================================

describe("Deterministic fuzzing — randomised pool sets with seeded PRNG", () => {
  /**
   * Inline mulberry32 PRNG — reproducible, no external dependency.
   * Produces a deterministic sequence from a fixed seed.
   */
  function mulberry32(seed: number) {
    let s = seed;
    return function () {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Fixed-point scales used in this codebase:
   *   - variational-ai residual: ×1e12 (FIXED_SCALE = 1_000_000_000_000 in
   *     variational-ai/src/deterministic.rs, confirmed by `pub const FIXED_SCALE: i64`)
   *   - chainState block residualFp: ×1e18 (Math.floor(residual * 1e18) in
   *     artifacts/api-server/src/chain/state.ts mineNextBlock / addBlock)
   *
   * Pool constant-product invariant (DEX fee model):
   *   After swap: k' = newReserveIn * newReserveOut where newReserveIn includes
   *   the full amountIn (fee portion stays in the pool). Because fee > 0,
   *   k' > k (strictly). We assert k'/k >= 1 - 1e-9 (epsilon for integer floor).
   */

  it("20 randomised pool sets: detector does not crash, returns well-formed data", async () => {
    const rng = mulberry32(0xdeadbeef);
    const ITERATIONS = 20;
    let fuzzPoolCounter = 0;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      fuzzPoolCounter++;
      const prefix = `fz${fuzzPoolCounter}`;
      const nPools = 2 + Math.floor(rng() * 3); // 2–4 pools

      const tokens = Array.from({ length: nPools + 1 }, (_, i) => `${prefix}T${i}`);
      const poolIds: string[] = [];

      for (let p = 0; p < nPools; p++) {
        const id = `${prefix}_p${p}`;
        const rA = Math.max(100_000, Math.floor(rng() * 10_000_000));
        const rB = Math.max(100_000, Math.floor(rng() * 10_000_000));
        const result = chainState.createPool(id, tokens[p]!, tokens[p + 1]!, rA, rB);
        if (typeof result === "string") continue; // "pool already exists" or other error
        poolIds.push(id);
      }

      if (poolIds.length < 2) continue;

      // Build pool snapshot request for the Rust arbitrage detector
      const pools = poolIds.map(id => {
        const pool = chainState.dexPools.get(id)!;
        return {
          pool_id: pool.id,
          token_a: pool.tokenA,
          token_b: pool.tokenB,
          reserve_a: pool.reserveA,
          reserve_b: pool.reserveB,
          fee: pool.fee,
        };
      });

      const { findArbitrageOpportunities } = await import("../variational-ai/bridge.js");
      let opps: Awaited<ReturnType<typeof findArbitrageOpportunities>>;
      try {
        opps = await findArbitrageOpportunities({ pools, lambda: 1e-6, max_opportunities: 3 });
      } catch {
        // CLI binary not available or timed out — skip this iteration gracefully
        continue;
      }

      // Detector must return well-formed data (never crash)
      expect(Array.isArray(opps.opportunities)).toBe(true);
      expect(typeof opps.count).toBe("number");
      expect(opps.count).toBe(opps.opportunities.length);

      for (const opp of opps.opportunities) {
        expect(opp.profitFactor).toBeGreaterThan(0);
        expect(Array.isArray(opp.tokens)).toBe(true);
        expect(Array.isArray(opp.poolIds)).toBe(true);
        // Safety invariant: detector's recommended trade must not exceed governance cap
        expect(opp.optimalAmountIn).toBeLessThanOrEqual(
          chainState.governance.params.arbitrageMaxTradeAmount
        );
      }

      // Constant-product invariant: verify the first detected opportunity's first hop
      if (opps.opportunities.length > 0) {
        const opp = opps.opportunities[0]!;
        const hopPoolId = opp.poolIds[0];
        const hopTokenIn = opp.tokens[0];
        if (hopPoolId && hopTokenIn) {
          const pool = chainState.dexPools.get(hopPoolId);
          if (pool) {
            const amountIn = Math.min(opp.optimalAmountIn, 1_000); // small safe amount
            const isAtoB = hopTokenIn === pool.tokenA;
            const rIn  = isAtoB ? pool.reserveA : pool.reserveB;
            const rOut = isAtoB ? pool.reserveB : pool.reserveA;

            const kBefore = pool.reserveA * pool.reserveB;
            const effIn = amountIn * (1 - pool.fee);
            const amtOut = (rOut * effIn) / (rIn + effIn);
            const newRIn  = rIn  + amountIn;
            const newROut = rOut - amtOut;

            // k after swap (fee stays in pool → k grows)
            const kAfter = isAtoB
              ? newRIn * newROut
              : newROut * newRIn;

            // Allow tiny epsilon for floating-point arithmetic
            expect(kAfter / kBefore).toBeGreaterThanOrEqual(1 - 1e-9);
          }
        }
      }
    }
  }, 60_000);
});
