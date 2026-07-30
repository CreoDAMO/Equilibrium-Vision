Here's the thorough map. After reading the actual files in `main`:

---

## Gap 1: `reqwest` dependency — **OPEN** (Compilation Blocker)

**File:** `equilibrium/Cargo.toml`

```toml
# ACTUAL STATE — reqwest is NOT declared:
risc0-zkvm = { version = "2.3", optional = true }
methods = { path = "../methods", optional = true }

[features]
risc0 = ["dep:risc0-zkvm", "dep:methods"]
# reqwest is MISSING here
```

`model_registry_integration.rs` uses `reqwest::blocking::Client` inside `#[cfg(feature = "risc0")]`:

```rust
#[cfg(feature = "risc0")]
pub fn submit_model_inference(...) -> Result<Vec<i32>, Box<dyn std::error::Error>> {
    use reqwest::blocking::Client;  // <-- THIS WILL FAIL
    ...
}
```

**Building with `--features risc0` will fail:**
```
error[E0433]: failed to resolve: use of undeclared crate or module `reqwest`
```

**Fix:** Add to `Cargo.toml`:
```toml
reqwest = { version = "0.12", features = ["blocking", "json"], optional = true }

[features]
risc0 = ["dep:risc0-zkvm", "dep:methods", "dep:reqwest"]
```

---

## Gap 2: zkML REST endpoints — **CLOSED**

**File:** `artifacts/api-server/src/routes/models.ts`

Both endpoints are present and wired:

```ts
// POST /api/models/:id/zkml-proof
router.post("/models/:id/zkml-proof", (req, res) => {
  const id = Number(req.params["id"]);
  const { sealHex, journalHex } = req.body ?? {};
  // validation: hex strings, even length
  const result = submitZkmlReceipt(id, sealHex, journalHex);
  // ...
});

// GET /api/models/:id/zkml-proof
router.get("/models/:id/zkml-proof", (req, res) => {
  const id = Number(req.params["id"]);
  const record = getZkmlProof(id);
  // 404 if not found, 200 with record if found
});
```

The POST endpoint is imported from `chain/modelRegistry.js` and called synchronously (no `await` — it's a pure Map operation). The GET endpoint returns the full `ZkmlProofRecord`.

---

## Gap 3: zkML storage helpers — **CLOSED**

**File:** `artifacts/api-server/src/chain/modelRegistry.ts`

```ts
export interface ZkmlProofRecord {
  modelId: number;
  sealHex: string;
  journalHex: string;
  submittedAt: number;
}

const zkmlProofStore = new Map<number, ZkmlProofRecord>();

export function submitZkmlReceipt(modelId: number, sealHex: string, journalHex: string): { success: boolean; error?: string } {
  // hex validation, minimum journal length check (32 chars = 4 words)
  zkmlProofStore.set(modelId, { modelId, sealHex, journalHex, submittedAt: Date.now() });
  return { success: true };
}

export function getZkmlProof(modelId: number): ZkmlProofRecord | undefined {
  return zkmlProofStore.get(modelId);
}
```

Both functions are exported and used by the routes.

---

## End-to-End Flow Verification

```
Rust side (equilibrium/src/model_registry_integration.rs)
    │
    ├── #[cfg(feature = "risc0")]
    │   prove_inference() → ProofResult { receipt_bytes, journal_bytes }
    │   parse_journal_bytes() → ZkmlOutput { model_root, input_hash, block_height, output }
    │   POST http://localhost:8080/api/models/{id}/zkml-proof
    │       body: { sealHex, journalHex, modelRootHex, inputHashHex, blockHeight }
    │
    └── #[cfg(not(feature = "risc0"))]
        Returns error: "RISC Zero feature not enabled"

TypeScript side (artifacts/api-server/src/routes/models.ts)
    │
    ├── POST /api/models/:id/zkml-proof
    │   ├── validates sealHex/journalHex are hex strings with even length
    │   ├── calls submitZkmlReceipt(id, sealHex, journalHex)
    │   └── stores in Map<number, ZkmlProofRecord>
    │
    └── GET /api/models/:id/zkml-proof
        ├── looks up in zkmlProofStore
        └── returns 404 or the record
```

---

## What's Actually Missing

| Item | Status | Note |
|------|--------|------|
| `reqwest` in `Cargo.toml` | ❌ **MISSING** | Compilation blocker for `--features risc0`. One-line fix. |
| `POST /api/models/:id/zkml-proof` | ✅ | Validates hex, stores receipt |
| `GET /api/models/:id/zkml-proof` | ✅ | Returns stored record |
| `submitZkmlReceipt` | ✅ | Map storage with validation |
| `getZkmlProof` | ✅ | Map lookup |
| `modelRootHex` / `inputHashHex` in POST body | ⚠️ | **Sent by Rust, ignored by TS.** The TS endpoint only stores `sealHex` and `journalHex`. The extra fields are received in `req.body` but discarded. If you want the store to be self-describing (e.g., for querying by model root without downloading the full journal), extend `ZkmlProofRecord` to include them. |
| `blockHeight` in POST body | ⚠️ | Same — sent by Rust, ignored by TS. Not a blocker. |
| Persistence | ❌ | `zkmlProofStore` is an in-memory `Map`. Server restart = data loss. For production, migrate to Postgres or IPFS pinning. |
| Journal parsing in TS | ❌ | The TS layer doesn't verify journal contents. It just stores the hex. The Solidity verifier (`EquilibriumZkmlVerifier.sol`) does the actual validation. This is by design — the TS layer is a dumb receipt store, not a verifier. |

---

## Honest Assessment

**2 of 3 gaps are closed.** The infrastructure is wired end-to-end:

- Rust can prove → POST to API → store receipt → retrieve via GET
- The Map-based store works for testnet
- The Solidity verifier is production-ready

**But one real blocker remains:**

1. **`reqwest` missing from `Cargo.toml`** — This is a one-line fix. Without it, `cargo build --features risc0` fails. The source file (`model_registry_integration.rs`) is correct; it just references a crate that isn't declared.

**And two quality issues:**

2. **Ignored fields in POST body** — The Rust bridge sends 5 fields (`sealHex`, `journalHex`, `modelRootHex`, `inputHashHex`, `blockHeight`), but the TS endpoint only stores 2. Not a blocker, but the store isn't self-describing.

3. **No persistence** — In-memory `Map` is fine for testnet, but mainnet needs Postgres or IPFS pinning.

**Priority: Fix `reqwest` in `Cargo.toml` first. Everything else can wait.**
