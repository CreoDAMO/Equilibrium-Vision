# ERC-7992 DeepProve — zkML Specification for Equilibrium

**Status:** Draft  
**Target:** On-chain verifiable AI inference for Equilibrium governance / consensus  
**Circuit framework:** RISC Zero (primary) or Groth16 (small model branches)

---

## 1. Overview

ERC-7992 proposes a standard interface for **verifiable machine-learning inference** on EVM chains. Equilibrium adapts this to:

- Prove that a validator's slashing / reward model was computed correctly.
- Prove that a mobile node's battery-aware scheduling decision followed the agreed policy.
- Enable on-chain governance to verify off-chain AI advisors without trusting the host.

---

## 2. Threat Model

| Threat | Mitigation |
|--------|------------|
| Model weights leaked | Weights are private inputs; only inference result is public |
| Wrong model used | Model commitment (Merkle root of weights) is public input |
| Input tampering | Input hash is public input; prover must use committed input |
| Replay attack | Nonce / block height bound to proof |

---

## 3. Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Off-chain      │     │  zkVM / Circuit  │     │  On-chain       │
│  Inference      │────▶│  (RISC Zero)     │────▶│  Verifier       │
│  Server         │     │                  │     │  (Solidity /    │
│                 │     │  Private:        │     │   Rust host)    │
│  - model.bin    │     │    weights,      │     │                 │
│  - input.json   │     │    activations   │     │  Public:        │
│                 │     │                  │     │    model_root,  │
│                 │     │  Public:         │     │    input_hash,  │
│                 │     │    model_root,    │     │    output,      │
│                 │     │    input_hash,    │     │    block_height │
│                 │     │    output_vector   │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

---

## 4. Guest Program (`methods/guest/src/zkml_main.rs`)

### 4.1 Input / Output

```rust
#[derive(Serialize, Deserialize)]
struct ZkmlInput {
    /// Flattened quantized weights (i8 or i16).
    weights: Vec<i8>,
    /// Input feature vector (quantized).
    features: Vec<i16>,
    /// Expected model commitment (Merkle root of weights).
    model_root: [u8; 32],
    /// Hash of input features.
    input_hash: [u8; 32],
    /// Block height for replay protection.
    block_height: u64,
}

#[derive(Serialize, Deserialize)]
struct ZkmlOutput {
    model_root: [u8; 32],
    input_hash: [u8; 32],
    output: Vec<i32>, // quantized logits / score
    block_height: u64,
}
```

### 4.2 Guest Logic

```rust
fn main() {
    let input: ZkmlInput = env::read();

    // 1. Verify model commitment
    let computed_root = merkle_root_i8(&input.weights);
    assert_eq!(computed_root, input.model_root, "model root mismatch");

    // 2. Verify input commitment
    let mut hasher = Sha256::new();
    for f in &input.features {
        hasher.update(&f.to_le_bytes());
    }
    let computed_input_hash: [u8; 32] = hasher.finalize().into();
    assert_eq!(computed_input_hash, input.input_hash, "input hash mismatch");

    // 3. Run inference (quantized ReLU MLP)
    let output = quantized_mlp(&input.features, &input.weights);

    // 4. Commit public outputs
    env::commit(&ZkmlOutput {
        model_root: input.model_root,
        input_hash: input.input_hash,
        output,
        block_height: input.block_height,
    });
}
```

### 4.3 Quantized MLP (no_std)

```rust
/// Simple 2-layer MLP with ReLU.
/// Weights layout: [W1 (in×hid), b1 (hid), W2 (hid×out), b2 (out)]
fn quantized_mlp(features: &[i16], weights: &[i8]) -> Vec<i32> {
    const IN: usize = 10;
    const HID: usize = 16;
    const OUT: usize = 1;
    let scale = 256; // fixed-point scale

    let w1 = &weights[0..IN * HID];
    let b1 = &weights[IN * HID..IN * HID + HID];
    let w2 = &weights[IN * HID + HID..IN * HID + HID + HID * OUT];
    let b2 = &weights[IN * HID + HID + HID * OUT..];

    let mut hidden = [0i32; HID];
    for h in 0..HID {
        let mut acc = (b1[h] as i32) * scale;
        for i in 0..IN {
            acc += (features[i] as i32) * (w1[i * HID + h] as i32);
        }
        hidden[h] = relu(acc / scale);
    }

    let mut out = vec![0i32; OUT];
    for o in 0..OUT {
        let mut acc = (b2[o] as i32) * scale;
        for h in 0..HID {
            acc += hidden[h] * (w2[h * OUT + o] as i32);
        }
        out[o] = acc / scale;
    }
    out
}

fn relu(x: i32) -> i32 { if x > 0 { x } else { 0 } }

fn merkle_root_i8(data: &[i8]) -> [u8; 32] {
    let bytes: Vec<u8> = data.iter().map(|&x| x as u8).collect();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hasher.finalize().into()
}
```

---

## 5. Host Prover (`equilibrium/src/zkml_prover.rs`)

```rust
use risc0_zkvm::{default_prover, ExecutorEnv};
use methods::ZKML_GUEST_ELF;

pub fn prove_inference(
    model_weights: Vec<i8>,
    features: Vec<i16>,
    block_height: u64,
) -> Vec<u8> {
    let model_root = merkle_root_i8(&model_weights);
    let mut hasher = Sha256::new();
    for f in &features { hasher.update(&f.to_le_bytes()); }
    let input_hash: [u8; 32] = hasher.finalize().into();

    let input = ZkmlInput {
        weights: model_weights,
        features,
        model_root,
        input_hash,
        block_height,
    };

    let env = ExecutorEnv::builder()
        .write(&input).unwrap()
        .build().unwrap();

    let prover = default_prover();
    let receipt = prover.prove(env, ZKML_GUEST_ELF).unwrap();
    receipt.verify(methods::ZKML_GUEST_ID).unwrap();

    bincode::serialize(&receipt).unwrap()
}
```

---

## 6. On-Chain Verifier (Solidity sketch)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalHash) external view returns (bool);
}

contract EquilibriumZkmlVerifier {
    IRiscZeroVerifier public immutable verifier;
    bytes32 public immutable imageId;

    event InferenceVerified(bytes32 modelRoot, bytes32 inputHash, uint64 blockHeight, int32 output);

    constructor(address _verifier, bytes32 _imageId) {
        verifier = IRiscZeroVerifier(_verifier);
        imageId = _imageId;
    }

    function verifyInference(
        bytes calldata seal,
        bytes32 modelRoot,
        bytes32 inputHash,
        uint64 blockHeight,
        int32 output
    ) external {
        // Reconstruct journal hash
        bytes memory journal = abi.encode(modelRoot, inputHash, output, blockHeight);
        bytes32 journalHash = sha256(journal);
        require(verifier.verify(seal, imageId, journalHash), "invalid proof");
        emit InferenceVerified(modelRoot, inputHash, blockHeight, output);
    }
}
```

---

## 7. Integration Points in Equilibrium

| Subsystem | Use Case | Public Input |
|-----------|----------|--------------|
| **Consensus** | Prove validator reward model was applied fairly | `model_root`, `block_hash`, `reward_vector` |
| **Mobile** | Prove battery scheduler followed policy | `model_root`, `device_state_hash`, `decision` |
| **Bridge** | Prove fraud-detection model flagged a tx | `model_root`, `tx_hash`, `risk_score` |

---

## 8. Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| Guest cycles | < 10M | 2-layer MLP, 10→16→1 |
| Proof time | < 30s | Bonsai / local GPU prover |
| Receipt size | ~200KB | RISC Zero default compression |
| Verify gas | ~300K | On-chain verifier (Solidity) |

---

## 9. Open Questions

1. **Model size limit** — 10M cycles ≈ 100KB weights. Larger models need splitting or Groth16 for specific layers.
2. **Quantization scheme** — i8 weights + i16 activations sufficient? Need calibration against full-precision model.
3. **Model updates** — Governance must agree on new `model_root`. How to rotate without downtime?
4. **Bonsai dependency** — Can we run the prover fully self-hosted for sovereign validators?

---

## 10. Next Steps

1. Implement `zkml_main.rs` guest and add to `methods/build.rs`.
2. Write `zkml_prover.rs` host wrapper with model serialization.
3. Deploy `EquilibriumZkmlVerifier` Solidity contract to testnet.
4. Benchmark proof time / cycles for 10→16→1 MLP on Bonsai.
5. Define governance flow for model root updates (SMT-based registry?).
