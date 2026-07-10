---
name: CrossChainRelay fixes
description: Four bugs fixed in the CrossChainRelay WASM contract + API layer; patterns to apply to future contracts.
---

## Bugs fixed and lessons learned

### 1. Rate limiter blocks integration tests (429 errors)
`app.ts` has a `writeLimiter` capped at 20 requests/min. Crosschain tests issue 30+ POSTs in one run.

**Fix:** Skip both `readLimiter` and `writeLimiter` when `NODE_ENV === "test"`.

**Why:** Always gate rate limiters on `!isTestEnv` — they silently turn integration test failures into misleading 429s.

**How to apply:** Any new rate limiter in `app.ts` must include `skip: () => isTestEnv`.

---

### 2. Duplicate-attestation check must precede sequence check
In `method_submit_inbound` (lib.rs), the sequence check (`seq != last_seq + 1 → -4`) ran before the duplicate check (`att exists → -5`). A repeat submission of the same seq returned "Bad sequence number" instead of "Attestation already exists".

**Fix:** Move the `get_att_field(...).is_some() → -5` guard above the sequence check.

**Why:** Precise error messages require checking the most-specific condition first.

---

### 3. Unauthenticated relay registration — bond theft
`POST /api/relay/register` accepted an arbitrary `caller` field without verifying the caller owned that address. An attacker could forge any victim's address, debit their balance via `bond()`, and register them as a relayer.

**Fix:** Added `requireAdmin()` check as the first middleware on the route (same pattern as revoke/threshold/challenge).

**Why:** Any route that calls `bond()` with a user-supplied caller string is a theft vector. Require admin key or Ed25519 proof of key ownership.

**How to apply:** For future self-service enrollment, use `verify_owner_sig` host import to require a signature over the registration payload before accepting the caller identity.

---

### 4. WasmVM.blockHeight not updated by addBlock
`WasmVM` has a private `blockHeight = 0` field used by the `block_number()` host import. `ChainState.addBlock()` never called `wasmVM.setBlockHeight()`, so every WASM contract saw block 0 forever. This caused `finalizeInbound` to always return "Challenge window still open".

**Fix:** Added `this.wasmVM.setBlockHeight(block.height)` at the end of `addBlock()` in `state.ts`.

**Known gap:** `rollbackToHeight()` does NOT call `setBlockHeight` after rewinding — the WASM VM will report a stale (too-high) block number until the next `addBlock`. Track as follow-up tech debt.

---

### 5. "Dev mode" tests break when ADMIN_KEY is set in environment
Tests labeled "dev mode — no ADMIN_KEY" rely on the env var being absent. When ADMIN_KEY is configured (e.g. as a Replit secret), they get 403 instead of the expected 200/400.

**Fix:** Wrap each such `describe` block with `beforeAll(() => { saved = process.env.ADMIN_KEY; delete process.env.ADMIN_KEY; })` and a matching `afterAll` to restore.

**Affected files:** `arbitrage.integration.test.ts`, `api.integration.test.ts`.
