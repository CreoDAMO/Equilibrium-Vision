# Grafana Dashboards

Equilibrium exposes Prometheus-format metrics from the API server. This directory
contains a Prometheus scrape config and three ready-to-import Grafana dashboards
built against those metrics.

## Metrics endpoints

| Endpoint | Source | Contents |
|---|---|---|
| `GET /metrics` | `artifacts/api-server/src/routes/metrics.ts` | Chain height/finality, TPS, block time, mempool, peers, validators, staking, DEX pools |
| `GET /metrics/stratum` | `artifacts/api-server/src/routes/stratum-metrics.ts` | Stratum mining pool connections and abuse-rejection counters |

Both are plain-text Prometheus exposition format (`text/plain; version=0.0.4`) and
require no auth — treat the port as internal/firewalled in production, since the
metrics include per-validator and per-IP labels.

## Setup

1. **Run Prometheus** pointed at this repo's API server using `prometheus.yml` in
   this directory (edit the `targets` host:port if the API server isn't on
   `localhost:8080`, e.g. use your `$REPLIT_DEV_DOMAIN` for a deployed instance):
   ```bash
   prometheus --config.file=docs/grafana/prometheus.yml
   ```
2. **Run Grafana** (`grafana-server` or the official Docker image) and add a
   Prometheus data source pointing at your Prometheus instance
   (default `http://localhost:9090`).
3. **Import dashboards**: in Grafana, go to *Dashboards → New → Import*, and
   upload each JSON file below (or paste its contents). Select your Prometheus
   data source when prompted.

Neither Prometheus nor Grafana ship in this Repl — they're intended to run in
your own infra (or a separate Repl/VM) that scrapes this app's public metrics
endpoints. This directory only supplies the configuration to wire them up.

## Dashboards

- **`dashboard-chain-overview.json`** — chain height, finality lag, TPS, mempool
  pressure, block time vs. target, peer count, PoS difficulty/residual, and
  pending UTXO fees awaiting sweep. The at-a-glance health view for the network.
- **`dashboard-validators-staking.json`** — active/jailed/slashed validator
  counts, total bonded stake, per-validator bonded stake, uptime, blocks
  proposed, accumulated rewards, and slash events. Useful for validator
  operators and delegators monitoring the validator set.
- **`dashboard-stratum-pool.json`** — Stratum mining pool health: active
  connections/sessions, and abuse-pattern rejection counters (rate limit,
  duplicate share, per-IP connection cap) broken out by remote IP. Useful for
  spotting a single source hammering the pool.

## Alerting suggestions (not included as pre-built rules)

Once imported, consider adding Grafana alert rules for:
- `equilibrium_chain_finality_lag > 8` — finality stalling
- `equilibrium_validators_jailed > 0` or `equilibrium_validators_slashed > 0` — validator health
- `equilibrium_mempool_pressure > 0.9` — mempool congestion
- Sudden spikes in `equilibrium_stratum_*_rejections_total` — pool abuse
