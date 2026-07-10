# Delegator Guide

How to delegate (bond) EQU to a validator, earn a share of block rewards, and safely exit.

## What delegation does

Delegators bond EQU to a validator of their choice without running any infrastructure themselves. In return:

- You earn a share of that validator's block rewards and transaction fees, proportional to your bonded amount, **minus** the validator's commission rate (each validator sets its own — see `GET /api/validators` for current rates).
- Your bonded stake also counts toward that validator's total voting power for BFT finality — bigger bonded totals mean the network reaches ⅔-stake finality faster and with fewer large validators needed.
- You take on **slashing risk**: if your validator is slashed for double-signing, downtime, or proposing an invalid block, your delegated stake is slashed too (see the slash percentages in `docs/validator-setup.md`). Check a validator's slash history before delegating.

## Choosing a validator

```bash
curl $API_URL/api/validators
```

Or use the Explorer's **Validators** page, which shows each validator's bonded stake, commission, uptime, and slash history side by side. Click into a validator's detail page for its delegator list and fee-earnings history before committing funds.

## Delegating stake

```bash
curl -X POST $API_URL/api/stake \
  -H "Content-Type: application/json" \
  -d '{
    "address": "<your 40-hex-char address>",
    "validator": "<validator address to delegate to>",
    "amount": 50000
  }'
```

Or from the Explorer: **Staking** page → select a validator → enter an amount → sign and submit from your connected wallet.

## Checking your position

```bash
curl $API_URL/api/stake/<your-address>
```

Returns your active staking positions and anything currently in the unbonding queue. The Explorer's Staking page shows the same information with live rewards-earned figures per validator (visible on that validator's delegator table, e.g. `ValidatorDetail.tsx`'s delegators list: live stake, share %, rewards earned, and slash exposure).

## Unbonding (withdrawing)

```bash
curl -X POST $API_URL/api/unstake \
  -H "Content-Type: application/json" \
  -d '{ "address": "<your address>", "validator": "<validator address>", "amount": 50000 }'
```

Unbonding takes a **fixed 10-block waiting period** (`UNBONDING_PERIOD`) before funds are returned to your address — there is no way to cancel or speed this up once submitted. Your stake stops earning rewards and stops counting toward voting power as soon as unbonding begins, not when it completes.

## Governance

Delegators can vote directly on governance proposals with their own delegated stake (separate from — and not double-counted with — the validator's own self-bond vote). See the Explorer's **Governance** page, or `POST /api/governance/proposals/:id/vote` with an Ed25519-signed vote.

## Risk summary

| Risk | Mitigation |
|------|------------|
| Validator gets slashed (double-sign, downtime, invalid block) | Diversify across multiple validators; check slash history before delegating |
| Funds locked for 10 blocks on exit | Plan withdrawals ahead of when you need liquidity |
| This is a testnet, not mainnet | EQU here has no real-world value; do not treat balances as production funds — see README's "External infrastructure and ops" section for what mainnet-grade infra would require |
