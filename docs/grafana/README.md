# Grafana Dashboards

Equilibrium exposes Prometheus-format metrics from the API server. This directory
contains a complete, self-contained monitoring stack: a Prometheus scrape config,
three Grafana dashboards, and a `docker-compose.yml` that wires them to a live
Equilibrium node in a single command.

## Metrics endpoints

| Endpoint | Source | Contents |
|---|---|---|
| `GET /metrics` | `artifacts/api-server/src/routes/metrics.ts` | Chain height/finality, TPS, block time, mempool, peers, validators, staking, DEX pools |
| `GET /metrics/stratum` | `artifacts/api-server/src/routes/stratum-metrics.ts` | Stratum mining pool connections and abuse-rejection counters |

Both are plain-text Prometheus exposition format (`text/plain; version=0.0.4`) and
require no auth — treat the port as internal/firewalled in production, since the
metrics include per-validator and per-IP labels.

## Quick start (Docker)

**Step 1 — set the target** in `prometheus.yml`. Change the `targets` host to
point at your running Equilibrium API (the default is the current Replit dev URL):

```yaml
# prometheus.yml — edit the two `targets` lines:
static_configs:
  - targets: ["your-api-host-here"]   # ← change this
```

Common values:

| Where is the API? | `targets` value | `scheme` |
|---|---|---|
| Replit dev URL | `25fb2711-…janeway.replit.dev` | `https` |
| Deployed Replit app | `your-app.replit.app` | `https` |
| Local machine (same box as Docker) | `host.docker.internal:8080` | `http` |

**Step 2 — start the stack:**

```bash
cd docs/grafana
docker compose up -d
```

Then open:
- **Grafana** → http://localhost:3000 (login: `admin` / `admin`, change on first login)
- **Prometheus** → http://localhost:9090

All three dashboards and the Prometheus data source are auto-provisioned — nothing
needs to be imported or configured manually. Grafana opens directly to the Chain
Overview dashboard.

To use a custom Grafana password:
```bash
GRAFANA_PASSWORD=mysecret docker compose up -d
```

To reload Prometheus config after editing `prometheus.yml` (no restart needed):
```bash
curl -X POST http://localhost:9090/-/reload
```

To stop (data volumes are preserved):
```bash
docker compose down
```

To wipe all stored metrics and start fresh:
```bash
docker compose down -v
```

## Directory structure

```
docs/grafana/
  docker-compose.yml                     ← spin up Prometheus + Grafana
  prometheus.yml                         ← scrape config (edit targets before running)
  provisioning/
    datasources/prometheus.yml           ← auto-wires Prometheus data source in Grafana
    dashboards/provider.yml              ← tells Grafana where to load dashboard JSONs
  dashboard-chain-overview.json          ← chain health dashboard
  dashboard-validators-staking.json      ← validator set dashboard
  dashboard-stratum-pool.json            ← mining pool dashboard
```

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

## Manual import (no Docker)

If you prefer to manage Prometheus and Grafana yourself:

1. Run Prometheus with `prometheus.yml` from this directory after editing the
   target hosts:
   ```bash
   prometheus --config.file=docs/grafana/prometheus.yml
   ```
2. Run Grafana and add a Prometheus data source pointing at your Prometheus instance
   (default `http://localhost:9090`).
3. Import dashboards: in Grafana go to *Dashboards → New → Import*, and upload
   each JSON file in this directory. Select your Prometheus data source when prompted.

## Alerting suggestions (not included as pre-built rules)

Once imported, consider adding Grafana alert rules for:
- `equilibrium_chain_finality_lag > 8` — finality stalling
- `equilibrium_validators_jailed > 0` or `equilibrium_validators_slashed > 0` — validator health
- `equilibrium_mempool_pressure > 0.9` — mempool congestion
- Sudden spikes in `equilibrium_stratum_*_rejections_total` — pool abuse
