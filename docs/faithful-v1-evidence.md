# faithful-v1 evidence

Recorded against parent `1afa8be026124cb222f69b860d09e6691c5c5093`. The commands below were run from `/tmp/eq/equilibrium` with `--locked`.

| Check | Result |
| --- | --- |
| rustc | 1.98.1 (48a229cea 2026-09-01) |
| cargo | 1.98.1 (797e8a9bc 2026-08-05) |
| `cargo tree -p equilibrium-core --locked -i ark-groth16` | ark-groth16 v0.4.0 |
| Lockfile checksum | `20ceafa83848c3e390f1cbf124bc3193b3e639b3f02009e0e290809a501b95fc` |
| `cargo test --locked --lib faithful_v1::` | 5 passed |
| Test binary sha256 | `971f9f4abf6587a6df779923f09fc145866154bf5f54c8da29d7e1eaad6af4d0` |
| Verifying key sha256 | `fd66c1dcc648e5b10d8fe2c26481737e8815aff32e30fd735b602e5c23f4d7e8` |

The binary hash is the debug test executable from this run. It is not a release artifact.

Before the identifier limbs were named in a constraint, `every_public_input_has_a_non_identity_coefficient` was run on the `1afa8be` circuit with the same locked toolchain. It passed: all 19 verifying-key coefficients were non-identity. The claim that ark-groth16 0.4.0 gives an unused public input the identity coefficient does not hold for this circuit.

The limbs are now also named in a constraint and constrained to 128 bits. A changed predecessor, carried state, or header fails verification. A short public-input list is refused. The setup seed remains the development seed `0xFA17_0001`. The pinned verifying key is not a production ceremony.

`verifyTransitionProof` still rejects every proof. This circuit is not `applySuccessor`.
