import { Router } from "express";
import { chainState } from "../chain/index.js";

const router = Router();

function gauge(name: string, help: string, value: number, labels: Record<string, string> = {}): string {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  const metric = labelStr ? `${name}{${labelStr}}` : name;
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${metric} ${value}\n`;
}

function counter(name: string, help: string, value: number, labels: Record<string, string> = {}): string {
  const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",");
  const metric = labelStr ? `${name}{${labelStr}}` : name;
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${metric} ${value}\n`;
}

router.get("/metrics", (_req, res) => {
  const s = chainState;
  const lb = s.latestBlock;
  const lines: string[] = [];

  lines.push(gauge("equilibrium_chain_height", "Current chain height (number of blocks)", s.height));
  lines.push(gauge("equilibrium_chain_finalized_height", "BFT-finalized chain height", s.finalizedHeight));
  lines.push(gauge("equilibrium_chain_finality_lag", "Blocks behind finalized tip", s.height - s.finalizedHeight));
  lines.push(gauge("equilibrium_chain_difficulty", "Current Proof-of-Stationarity difficulty threshold", s.currentDifficulty));
  lines.push(gauge("equilibrium_chain_target_block_time_seconds", "Target block interval", 15));
  lines.push(gauge("equilibrium_chain_avg_block_time_seconds", "Rolling average block time (last 10 blocks)", s.avgBlockTime));
  lines.push(gauge("equilibrium_chain_tps", "Transactions per second (recent blocks)", s.tps));
  lines.push(gauge("equilibrium_chain_last_residual", "Lagrangian residual of latest block", lb?.residual ?? 0));
  lines.push(counter("equilibrium_chain_total_tx_count", "Total confirmed transactions", s.totalTxCount));

  lines.push(gauge("equilibrium_mempool_size", "Number of pending transactions in mempool", s.mempool.size));
  lines.push(gauge("equilibrium_mempool_pressure", "Mempool pressure ratio (0=empty, 1=full)", s.mempool.pressure));
  lines.push(gauge("equilibrium_utxo_pending_fees", "UTXO-model fees accrued since the last block, awaiting sweep to the next miner", s.pendingUtxoFees));

  lines.push(gauge("equilibrium_peers_total", "Total known peers", s.peers.length));
  lines.push(gauge("equilibrium_peers_connected", "Number of connected peers", s.peers.filter(p => p.connected).length));

  const activeValidators = [...s.validators.values()].filter(v => !v.slashed && !v.jailed);
  lines.push(gauge("equilibrium_validators_total", "Total registered validators", s.validators.size));
  lines.push(gauge("equilibrium_validators_active", "Active (non-slashed, non-jailed) validators", activeValidators.length));
  lines.push(gauge("equilibrium_validators_jailed", "Jailed validators", [...s.validators.values()].filter(v => v.jailed).length));
  lines.push(gauge("equilibrium_validators_slashed", "Permanently slashed validators", [...s.validators.values()].filter(v => v.slashed).length));
  lines.push(gauge("equilibrium_staking_total_bonded", "Total EQU bonded across all validators", s.totalBondedStake));
  lines.push(gauge("equilibrium_staking_unbonding_queue_size", "Number of unbonding entries in queue", s.unbondingQueue.length));

  for (const v of s.validators.values()) {
    const labels = { address: v.address, moniker: v.moniker };
    lines.push(gauge("equilibrium_validator_bonded_stake", "Bonded stake for a validator", v.bondedStake, labels));
    lines.push(gauge("equilibrium_validator_uptime", "Validator uptime ratio (0-1)", v.uptime, labels));
    lines.push(counter("equilibrium_validator_blocks_proposed", "Blocks proposed by this validator", v.blocksProposed, labels));
    lines.push(counter("equilibrium_validator_accumulated_rewards", "Total rewards accumulated", v.accumulatedRewards, labels));
    lines.push(counter("equilibrium_validator_slash_count", "Number of slash events", v.slashCount, labels));
  }

  for (const pool of s.dexPools.values()) {
    const labels = { pool_id: pool.id };
    lines.push(gauge("equilibrium_dex_reserve_a", "Reserve of token A in pool", pool.reserveA, labels));
    lines.push(gauge("equilibrium_dex_reserve_b", "Reserve of token B in pool", pool.reserveB, labels));
    lines.push(gauge("equilibrium_dex_total_liquidity", "Total liquidity tokens in pool", pool.totalLiquidity, labels));
    lines.push(counter("equilibrium_dex_tx_count", "Total swap transactions in pool", pool.txCount, labels));
    lines.push(counter("equilibrium_dex_volume_a", "Total volume of token A traded", pool.volumeA, labels));
    lines.push(counter("equilibrium_dex_volume_b", "Total volume of token B traded", pool.volumeB, labels));
  }

  lines.push(counter("equilibrium_gossip_events_total", "Total gossip events logged", s.gossipLog.length));
  lines.push(counter("equilibrium_slash_events_total", "Total validator slash events", s.slashEvents.length));

  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(lines.join("\n"));
});

export default router;
