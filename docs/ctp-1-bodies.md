# CTP-1 Bodies

The four helper bodies. This file is the control flow. [CTP-1 Helpers](ctp-1-helpers.md) is the commentary. Where they disagree, this file wins. Where this file and the interpreter disagree, neither closes C-007.

Interpreter: `site/src/protocol/constitution.ts`, `dex.ts`, `solver.ts`, `wasm-host.ts`, `coinomics.ts`, `authority.ts`, `crypto.ts`, as of `8941937`.

`refuse` means the transition returns `{ ok: false }` and writes nothing further. A write already performed in the same body stands only if the body later returns success. These four bodies do not roll back their own earlier writes. The caller cloned the predecessor before any of them ran.

## Body 1 — `applyStake`

Called once per stake evidence item, in array order, with one authority snapshot taken before the first item.

```
authoritySnapshot(Ω, quorumRatio):
  power ← empty map
  total ← 0
  for v in Ω.validators, in insertion order:
    if v.jailed or v.slashed or bondedStake is not a positive safe integer:
      continue
    next ← safeAdd(total, v.bondedStake)
    if next is null: refuse "bonded stake refused"
    total ← next
    power[v.address] ← v.bondedStake
  return { power, total, quorum: quorumRatio × total }
```

`safeAdd(a, b)` and `safeSub(a, b)` are null unless both arguments are safe integers and the ECMA-262 sum or difference is a safe integer.

`credit(addr, amount)`: if amount is not a safe integer ≥ 0, fail. If the account is absent, its balance is 0 and its nonce is 0. If the balance is not a safe integer ≥ 0, fail. If amount is 0: if the account is absent, insert `{ balance: 0, nonce: 0 }`; succeed. Otherwise write `balance + amount` and the old nonce, or fail if that sum is not a safe integer.

`debit(addr, amount)`: the same refusal rule. Amount 0 succeeds and does not insert an absent account. A positive amount writes `balance − amount` and the old nonce, or fails.

```
applyStake(Ω, op, params, authority):
  if op is unbond:
    if verifyUnbond(Ω.chainId, op) refuses: return that refusal
    v ← Ω.validators[op.validator]
    if v is missing or v.jailed or v.slashed: refuse "unbond refused"
    available ← 0
    for d in Ω.delegations, in order:
      if d.delegator ≠ op.delegator or d.validator ≠ op.validator: continue
      available ← safeAdd(available, d.amount) or refuse "unbond funds refused"
    if available < op.amount: refuse "unbond funds refused"
    nextStake ← safeSub(v.bondedStake, op.amount) or refuse "unbond refused"
    matureAt ← Ω.height + params.unbondingPeriod
    if matureAt is not a safe integer: refuse "unbond refused"
    left ← op.amount
    kept ← empty list
    for d in Ω.delegations, in order:
      if left = 0 or d does not match delegator and validator:
        append d to kept
        continue
      if d.amount > left:
        append d with amount (d.amount − left)
        left ← 0
      else:
        left ← left − d.amount
        do not append d
    if left ≠ 0: refuse "unbond funds refused"
    Ω.delegations ← kept
    v.bondedStake ← nextStake
    append { delegator, validator, amount: op.amount, matureAt } to Ω.unbonding
    return success

  if op is delegate:
    if op.publicKey and op.signature are both empty: refuse "delegate authority refused"
    if verifyDelegate(Ω.chainId, op) refuses: return that refusal
    v ← Ω.validators[op.validator]
    if v is missing or v.jailed or v.slashed: refuse "delegate refused"
    if op.amount is not a positive safe integer: refuse "delegate amount refused"
    nextStake ← safeAdd(v.bondedStake, op.amount) or refuse "delegate amount refused"
    if debit(Ω.ledger, op.delegator, op.amount) fails: refuse "delegate funds refused"
    v.bondedStake ← nextStake
    append { delegator, validator, amount: op.amount } to Ω.delegations
    return success

  if op is claim:
    v ← Ω.validators[op.address]
    if v is missing or v.accumulatedRewards is not a positive safe integer:
      refuse "claim refused"
    if credit(Ω.ledger, op.address, v.accumulatedRewards) fails: refuse "claim refused"
    v.accumulatedRewards ← 0
    return success

  if op is slash:
    v ← Ω.validators[op.validator]
    if v is missing or v.slashed or v.jailed: refuse "slash refused"
    if v.bondedStake is not a positive safe integer: refuse "slash refused"
    burned ← floor(v.bondedStake × 0.05) if reason is double_sign
             floor(v.bondedStake × 0.01) if reason is downtime
    if burned is not a safe integer ≥ 0 or burned > v.bondedStake: refuse "slash refused"
    nextStake ← safeSub(v.bondedStake, burned) or refuse "slash refused"
    v.bondedStake ← nextStake
    v.slashed ← true
    if reason is double_sign: v.jailed ← true
    return success

  if op is vote:
    p ← the proposal whose id is op.id
    if p is missing or p.status ≠ open: refuse "vote refused"
    if op.voter is not a key of authority.power: refuse "vote refused"
    if any ballot on p has voter op.voter: refuse "vote already cast"
    tally ← safeAdd(p[op.option], authority.power[op.voter]) or refuse "vote refused"
    p[op.option] ← tally
    append { voter: op.voter, option: op.option } to p.ballots
    yesNo ← safeAdd(p.yes, p.no)
    total ← null if yesNo is null, else safeAdd(yesNo, p.abstain)
    if total ≠ null and authority.total > 0 and total ≥ authority.quorum:
      p.status ← passed if p.yes > p.no, else failed
    return success

  if op is propose:
    if op.proposer is not a key of authority.power: refuse "proposal proposer unauthorized"
    if op.deposit is not a safe integer ≥ 0: refuse "proposal deposit refused"
    if op.id is not a safe integer ≥ 0: refuse "proposal deposit refused"
    if op.title is not a string or its length > 80: refuse "proposal deposit refused"
    if any proposal has the same id: refuse "proposal already exists"
    if debit(Ω.ledger, op.proposer, op.deposit) fails: refuse "proposal deposit refused"
    if either coupling field is present:
      if the key is not hash, structural, continuity, mempool, or fees: refuse "coupling is not a coupling"
      if the value is not a finite number: refuse "coupling is not a coupling"
      record both
    else:
      record neither
    insert at the front of Ω.proposals:
      { id, title, proposer, deposit, yes: 0, no: 0, abstain: 0, status: open, ballots: [], coupling if recorded }
    return success

  refuse "stake evidence refused"
```

`verifyDelegate` and `verifyUnbond` run before any balance or stake write of that op. Each requires a 40-hex delegator, a 40-hex validator, a 64-hex public key, a 128-hex signature, and a positive safe integer amount. The signature is Ed25519 over the UTF-8 of `authorityPreimage`. The address derived from the public key must equal the delegator. The derived address is the first 40 hex characters of SHA-256 of the 32-byte key.

The preimage is eleven fields joined by `|`:

`eq-authority`, `v1`, the chain id, the op, the delegator, the validator, the decimal amount, then four empty fields.

A delegate preimage therefore ends in `amount||||`. An unbond preimage is the same text with `unbond` in the op field. Neither check runs for claim, slash, vote, or propose.

Slash does not change delegation rows. The snapshot is not rebuilt between ops. A proposal marked `passed` here is not opened in this transition.

## Body 2 — effects

The liquid reward is fixed before this body. `rewardOf` is `max(0, floor(minerReward(...)))`.

```
blockReward(height, base, interval):
  if height is not finite or height < 0: return 0
  if interval ≤ 0: return base
  return base × (1/2) ^ (height / interval)

quality(R, target):
  if R or target is not finite, or either is negative: return 0
  return min(1, target / (R + 1e-9))

minerReward(height, R, target, base, interval):
  return blockReward(height, base, interval) × quality(R, target)
```

`R` is the canonical residual from body 3. It is not the fixed-point value and not the territory residual.

```
issuanceSplit(validators, miner, reward):
  v ← validators[miner]
  if v is missing or v.jailed or v.slashed: return { liquid: reward, staked: 0 }
  liquid ← floor(reward × v.commission)
  return { liquid, staked: reward − liquid }
```

```
quoteSwap(pool, tokenIn, amountIn):
  if amountIn is not finite or amountIn ≤ 0: return 0
  if tokenIn is tokenA: reserveIn ← reserveA, reserveOut ← reserveB
  else if tokenIn is tokenB: reserveIn ← reserveB, reserveOut ← reserveA
  else: return 0
  if reserveIn ≤ 0 or reserveOut ≤ 0: return 0
  dx ← amountIn × (1 − pool.fee)
  if dx ≤ 0: return 0
  return floor( (dx × reserveOut) / (reserveIn + dx) )

applySwap(pool, tokenIn, amountIn):
  out ← quoteSwap(pool, tokenIn, amountIn)
  if out ≤ 0: return 0
  if tokenIn is tokenA:
    reserveA ← reserveA + amountIn
    reserveB ← reserveB − out
  else:
    reserveB ← reserveB + amountIn
    reserveA ← reserveA − out
  txCount ← txCount + 1
  return out
```

The three writes in `applySwap` are not passed through `safeAdd`. `monetaryError` does not read reserves.

```
applyEffects(Ω, txs, miner, liquid, swaps):
  for tx in txs, in order:
    if amount is not a positive safe integer, or fee is not a safe integer ≥ 0:
      refuse "amount refused"
    total ← safeAdd(amount, fee) or refuse "amount refused"
    sender ← Ω.ledger[tx.from], or { balance: 0, nonce: 0 } if absent
    if sender.nonce is not a safe integer ≥ 0, or tx.nonce ≠ sender.nonce:
      refuse "bad nonce"
    if sender.balance is not a safe integer ≥ 0, or sender.balance < total:
      refuse "insufficient funds"
    left ← safeSub(sender.balance, total) or refuse "amount refused"
    Ω.ledger[tx.from] ← { balance: left, nonce: sender.nonce + 1 }
    if credit(Ω.ledger, miner, fee) fails: refuse "amount refused"
    pool ← the first pool whose (address, or poolAddress(id) when address is empty) equals tx.to
    if pool exists:
      out ← applySwap(pool, pool.tokenA, amount)
      if out > 0:
        insert at the front of swaps:
          { poolId, trader: tx.from, amountIn: amount, amountOut: out,
            tokenIn: tokenA, tokenOut: tokenB, timestamp: tx.timestamp }
    else if credit(Ω.ledger, tx.to, amount) fails:
      refuse "amount refused"
  if liquid is not a safe integer ≥ 0, or credit(Ω.ledger, miner, liquid) fails:
    refuse "reward refused"
  return success
```

`poolAddress(id)` is the first 40 hex characters of SHA-256 of the UTF-8 text `eq-pool:` concatenated with the id.

Effects always pass `tokenA` as the input token. A pool recipient is never credited `amount`. If `applySwap` returns 0, the pool is unchanged, no swap event is recorded, the sender has already paid amount and fee, and the amount has no destination. The swap list is not a field of `Ω`.

## Body 3 — residual

This body does not search for a nonce. It evaluates the nonce it is given.

```
pad32(hex):
  decode hex to bytes
  if the length is 32: return those bytes
  return the first 32 bytes, or the bytes followed by zero bytes, whichever fits 32

headerDigest(parent, merkle, timestamp, nonce, txHashes):
  parts ← pad32(parent), pad32(merkle),
           uint64-le(timestamp), uint64-le(nonce)
  for each hash, in order: append pad32(hash)
  return SHA-256(concatenation of parts)

firstU64(digest):
  return the first 8 bytes as an unsigned little-endian integer
```

`uint64-le` masks with `2^64 − 1`. `Number(firstU64)` is the ECMA-262 conversion. Values above `2^53` are not exact. `φ = (1 + sqrt(5)) / 2` in that same arithmetic.

```
evaluateResidual(parent, merkle, timestamp, nonce, difficulty, txs, work, pressure, λ):
  digest ← headerDigest(...)
  h ← Number(firstU64(digest)) / 2^64
  τ ← min(0.95, max(0.05, 1_000_000 / (difficulty + 1_000_000) + 0.35))
  vHash ← max(h − τ, 0)
  vStruct ← abs(h − 1/φ)
  vChain ← 0 if work > 0, else 1
  vMem ← min(1, max(0, canonicalPressure(pressure)))
  fees ← the sum of tx.fee by ordinary addition
  vFee ← max(0, vMem − min(1, fees / 1_000_000))
  canonical ←
      λ.hash × vHash²
    + λ.structural × vStruct²
    + λ.continuity × vChain²
    + λ.mempool × vMem²
    + λ.fees × vFee²

  hashVal ← firstU64(digest)
  hashViolation ← max(Number(hashVal) − difficulty, 0)
  structuralViolation ← abs(Number(hashVal) − difficulty / φ)
  chainViolation ← 0 if work > 0, else 1
  mempoolViolation ← pressure
  feeDeficit ← pressure × 1_000_000
  txViolation ← 0 if fees ≥ feeDeficit, else (feeDeficit − fees) / 1_000_000
  territory ←
      λ.hash × hashViolation²
    + λ.structural × structuralViolation²
    + λ.continuity × chainViolation²
    + λ.mempool × mempoolViolation²
    + λ.fees × txViolation²

  canonicalFp ← −1 if canonical is not finite and ≥ 0, else floor(canonical × 10^18)
  territoryFp ← −1 if territory is not finite and ≥ 0, else floor(territory × 10^18)
  return those values, the five canonical violations, h, and the decimal text of hashVal
```

`canonicalPressure` is `Number(pressure.toFixed(6))` when that is finite, otherwise the original value when the original is not finite. The reward and the header's residual field use `canonical` and `canonicalFp`. They do not use `territory`.

The caller passes work `max(0, predecessorHeight + 1)`, the opened couplings, and one `{ hash, fee }` per transaction in order. The parent hash and the Merkle root are the ones the seal will bind.

## Body 4 — wasm host

Only `successor` builds the derived map. `applySuccessor` accepts that map and refuses a wasm call list without it. `wasmAfter` is not read.

```
executeWasm(Ω, evidence):
  storage ← a new map copied from Ω.wasm, in its insertion order
  blockNumber ← max(0, Ω.height)
  for call in evidence.wasm, in order:
    if call.method is init:
      methodId ← 0
      args ← UTF-8(call.caller)
    else if call.method is pause:
      methodId ← 2
      args ← empty
    else:
      methodId ← 3
      args ← empty
    result ← callArbitrage(methodId, args, caller: call.caller, storage, blockNumber)
    if result.code ≠ 1: refuse "wasm {method} returned {code}"
  return storage
```

The returned map is the host map. It is not the sorted entry list that `callArbitrage` also returns.

```
callArbitrage(methodId, args, caller, storage, blockNumber):
  logs ← empty
  instantiate ARBITRAGE_WASM with imports:
    storage_get(key) → 0 if storage has no key
                      otherwise write the value into wasm memory and return its byte length
    storage_set(key, value) → storage[key] ← value
    log(text) → append text to logs
    block_number() → blockNumber as an unsigned 32-bit integer
    caller_address() → write the first 40 characters of caller into wasm memory and return that byte length
    gov_param() → 0
    dex_multi_swap() → −1
    call_contract() → −1
  export memory, alloc, and call from the instance
  if args is empty: ptr ← 0
  else: ptr ← alloc(length of args), and copy args into memory at ptr
  code ← call(methodId, ptr, length of args)
  return { code, logs, entries of storage sorted by key }
```

A repeated `storage_set` on an existing key replaces the value and does not move the key. `dex_multi_swap` does not call `applySwap`. The log list is not written into `Ω`. The Ed25519 check in `gateWasmCaller` is not performed in this body.

`applySuccessor`, after material and only when the evidence wasm list is non-empty, replaces `Ω.wasm` with a new map copied from this storage.

## What these bodies do not include

Bitcoin admission, ethereum admission, settlement, withdrawal application, model admission, transaction selection, difficulty adjustment, and the instructions inside `ARBITRAGE_WASM` are outside these four bodies. A transcription of these four is not a transcription of `Reference`. C-007 remains open.
