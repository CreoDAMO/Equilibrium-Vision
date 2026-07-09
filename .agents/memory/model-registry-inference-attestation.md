---
name: ModelRegistry inference attestation design
description: Why ModelRegistry's inference-proof feature is an Ed25519 receipt, not a zkML proof
---

When asked to extend `ModelRegistry` with "inference verification" (from an old draft citing ERC-7992/Groth16/EIP-165), the chosen design reused the repo's existing `verify_owner_sig` host import (already proven in the multisig contract) to attest "keyholder X signed a claim that model M mapped inputHash→outputHash", rather than implementing a real zkML circuit.

**Why:** True zkML correctness proofs need a per-model witness generator + SNARK circuit over the model's arithmetic — a fundamentally different, model-architecture-specific engineering investment than this codebase's existing optimistic-oracle pattern (propose/verify/challenge). Faking a "proof" that doesn't check computation would be dishonest; the honest, useful primitive available today is signed attribution, not correctness.

**How to apply:** If asked to revisit this later for real correctness guarantees, treat it as a new, scoped effort (witness generator + circuit + verifier), not an incremental patch on the attestation method. Don't conflate "attested" with "proven" in any UI/API copy — see `LIMITATIONS.md` §1b for the exact wording used.
