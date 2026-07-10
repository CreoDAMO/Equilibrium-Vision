# Validator Setup Guide

This guide covers registering and operating a validator on the Equilibrium testnet stack running in this Replit environment. For provisioning a standalone external node, see `docs/testnet-deployment.md`.

## Background

- Four genesis validators (`Miner-Alpha`, `Miner-Beta`, `Validator-Gamma`, `Validator-Delta`) start bonded at genesis — see `equilibrium_validator_bonded_stake` on `/metrics` or `GET /api/validators` for current stake.
- Finality is Tendermint-style: every block triggers a voting round, and once ≥ ⅔ of total bonded stake has voted for a block hash it is marked **finalized**. `finalizedHeight` only ever moves forward.
- Validators earn block rewards and transaction fees proportional to bonded stake, minus their configured commission (paid to delegators — see `docs/delegator-guide.md`).

## Becoming a validator (bonding stake)

There is no separate "validator registration" endpoint in the current build — stake is bonded via the same staking endpoint delegators use:

```bash
curl -X POST $API_URL/api/stake \
  -H "Content-Type: application/json" \
  -d '{
    "address": "<your 40-hex-char address>",
    "validator": "<validator address you are bonding to>",
    "amount": 1000000
  }'
```

Check `GET /api/validators` for existing validator addresses, and `GET /api/staking/summary` for global bonding stats.

> Genesis validators are hardcoded in `artifacts/api-server/src/chain/state.ts` for the testnet's initial validator set. Adding a brand-new (non-genesis) validator identity requires a code change to that genesis list today — this is a testnet limitation, not a governance-controlled process yet.

## Monitoring your validator

- `GET /api/validators/:addr` — bonded stake, uptime, slash history
- `GET /api/validators/:addr/fees` — per-block miner fee income
- `GET /api/validators/:addr/earnings` — aggregate coinbase + fee totals
- Explorer → **Validators** page → click through to a validator's detail page for the same data with a Fee Earnings tab
- Prometheus: `equilibrium_validator_bonded_stake`, `equilibrium_validator_uptime`, `equilibrium_validator_blocks_proposed`, `equilibrium_validator_accumulated_rewards`, `equilibrium_validator_slash_count` (all labeled by `moniker`) — see the **Validators & Staking** Grafana dashboard in `docs/grafana/`

## Slashing conditions

| Reason | Slash % | Effect |
|--------|---------|--------|
| `double_sign` | 5% of stake | Permanent removal from the active set |
| `downtime` | 1% of stake | Uptime penalty; jailed after 3 events |
| `invalid_block` | 1% of stake | Uptime penalty |

Slashing is triggered via `POST /api/validators/:addr/slash`, gated by the `X-Admin-Key` header (`ADMIN_KEY` / `ADMIN_API_KEY` env var) or, when `ADMIN_MULTISIG_ADDRESS` is configured, by the on-chain M-of-N multisig instead of a single key. There is no automatic downtime/double-sign detector wired into consensus yet on this testnet build — slashing today is an operator/governance action, not (yet) automatic.

## Unbonding

Validators (and delegators) exit via `POST /api/unstake`. Funds enter a **10-block unbonding period** (`UNBONDING_PERIOD` in `chain/state.ts`) before being returned — this cannot be sped up. During unbonding, the position no longer counts toward voting power or reward share.

## Governance participation

Validators vote on governance proposals using **self-bond only** (bonded stake minus delegated stake) to avoid double-counting delegator voting power — delegators vote separately with their own delegation. See the Explorer's **Governance** page or `POST /api/governance/proposals/:id/vote` (requires an Ed25519-signed vote — `publicKey` + `signature`, exactly 64/128 hex chars respectively).

## Operational notes specific to this environment

- This Replit-hosted node is a single testnet instance — there is no multi-region validator/sentry topology here (see `docs/testnet-deployment.md` and the README's "External infrastructure and ops" section for what that would require outside Replit).
- Data persists to the Postgres workflow's local disk (`.pgdata/`). It is not backed up or replicated — do not treat this environment as a production validator; it's for development, demos, and protocol testing.
