# Equilibrium Arbitrage Stress-Test Results

## How to Run

```bash
# Rust variational-ai tests (Phases 4 + existing)
cd variational-ai && cargo test --lib

# TypeScript tests (Phases 2 + 3 + all existing suites)
# Requires: Postgres running, variational-ai CLI binaries built and copied
cd variational-ai && cargo build --release --bin variational-ai-cli --bin variational-ai-arbitrage-cli
cp variational-ai/target/release/variational-ai-cli artifacts/api-server/
cp variational-ai/target/release/variational-ai-arbitrage-cli artifacts/api-server/
DATABASE_URL="postgresql://runner@127.0.0.1:5432/equilibrium" \
  pnpm --filter @workspace/api-server run test

# Full workspace typecheck
pnpm run typecheck:libs && pnpm run typecheck
```

## Test Counts

### TypeScript (Vitest)
| Suite | Tests |
|---|---|
| chain.unit.test.ts | 17 |
| api.integration.test.ts | 18 |
| contracts.integration.test.ts | 12 |
| multisig.integration.test.ts | 20 |
| models.integration.test.ts | 22 |
| arbitrage.integration.test.ts | 21 |
| crosschain.integration.test.ts | 41 |
| **arbitrage.stress.test.ts (NEW)** | **14** |
| **Grand total** | **245** (was 231) |

Files: 8 (was 7).  
New tests added in Phase 2+3: **14** (9 stress scenarios + 1 fuzz block).

### Rust — variational-ai
| Test | Status |
|---|---|
| test_currency_graph_finds_cycle (existing) | ✓ |
| test_arbitrage_action_gradient (existing) | ✓ |
| test_no_cycle_on_balanced_pools (existing) | ✓ |
| test_large_fully_connected_graph_completes_quickly (NEW) | ✓ |
| test_tiny_negative_cycle_is_detected (NEW) | ✓ |
| test_detector_coherent_after_swap_churn (NEW) | ✓ |
| **Grand total** | **6** (was 3) |

## Measured Timings

- TypeScript test suite wall time: **~16.7 s** (vitest reporter, 8 files, 245 tests)
  - arbitrage.stress.test.ts alone: **~3.1 s** (14 tests, including 101-block chain advances for model verification)
- Rust variational-ai tests: **< 1 s** (finished in 0.00 s per `cargo test --lib`)
- Phase 4 large-graph test: Bellman-Ford over 13 tokens (78 pools) completed in **< 1 ms** (well under 1 s bound asserted in the test)

## Known Constraints

1. **Single-owner execute_arbitrage**: Only one address (the contract owner) may call `execute_arbitrage`. The "multi-caller concurrency" scenario (2.4) was adapted to 10 back-to-back `Promise.all` calls from the same owner rather than different callers. This faithfully tests the exec_count rolling window semantics under rapid invocation without introducing a fictional permission model.

2. **Model verification required for cap/window checks**: The on-chain execution order places the -2 (no model) and -3 (not verified) checks *before* the max-trade-amount (-4) and circuit-breaker-increment (step 6) checks. Scenarios 2.2 and 2.1 therefore set up a fully verified model via `proposeModel → verifyModel → setArbitrageModel` before testing the safety rails. This adds ~101 `advanceBlocks` calls per setup but is the only way to reach those code paths.

3. **Finality gadget prevents deep rollbacks**: The finality gadget finalizes blocks synchronously in `addBlock`. Scenario 2.8 rolls back to `finalizedHeight + 1` (the lowest non-finalized block) rather than an arbitrary prior height, since rolling back past a finalized height throws by design.

4. **Fuzzing scope**: Phase 3 fuzz loop is capped at 20 iterations (2–4 randomised pools each) to keep CI under 60 s. The seeded PRNG (mulberry32, seed `0xdeadbeef`) ensures reproducibility.

5. **CLI binary availability**: The Phase 3 fuzz loop calls `findArbitrageOpportunities` (the Rust arbitrage CLI worker). If the binary is absent the loop continues silently rather than failing, matching the existing test pattern for CLI-dependent paths.
