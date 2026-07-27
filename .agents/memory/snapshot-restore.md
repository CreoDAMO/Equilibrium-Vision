---
name: Snapshot-based chain restore
description: How initChain uses state snapshots for fast startup; periodic snapshot cadence; safe pruning helper
---

# Snapshot-based chain restore in `chain/index.ts`

## The rule
`initChain()` tries `loadLatestSnapshot()` first. On hit: build a seeded-but-empty ChainState (validators/DEX/peers), overwrite ledger + UTXO with snapshot data, push snapshot-era blocks into `state.blocks` WITHOUT calling `addBlock` (tx indexes rebuilt manually), then replay post-snapshot blocks through `addBlock`. On miss: full block replay as before.

**Why:** Replaying every block on restart is O(N) in chain length. After a snapshot at height H, startup is O(N-H). This is critical for long-running chains.

**How to apply:** Any time startup feels slow or the chain exceeds a few thousand blocks, confirm `SNAPSHOT_INTERVAL = 100` in `chain/index.ts` is triggering snapshots in the mining loop.

## Periodic snapshots
`runMiningCycle` calls `takeSnapshot()` every `SNAPSHOT_INTERVAL = 100` blocks (fire-and-forget). Snapshots upsert into `state_snapshots` table keyed by height.

## Safe pruning
`safelyPruneOldBlocks(keepBlocks?)` (exported from `chain/index.ts`) calls `takeSnapshot()` then `pruneOldBlocks()`. `pruneOldBlocks` in persistence.ts refuses to prune if no snapshot covers the prune boundary (unless `ENABLE_UNSAFE_PRUNING=true`).

## Snapshot schema
`lib/db/src/schema/state-snapshots.ts` → `state_snapshots` table: `height` (PK), `block_hash`, `state_root`, `ledger` (JSONB), `utxos` (JSONB), `created_at`. Contract storage is NOT in snapshots — it lives in the `contracts` table's `storage` column.

## What the snapshot does NOT capture
- `txIndex` / `addressTxs` for snapshot-era blocks — these are rebuilt by the fast-path by iterating over loaded blocks (cheaper than addBlock since no ledger mutations happen)
- `validators`, `dexPools`, `stakes`, `unbondingQueue` — seeded from genesis doc or hardcoded dev data; not snapshot-preserved (acceptable for testnet)
- `blockStats`, `finalityRounds` — ephemeral; only rebuilt for post-snapshot blocks
