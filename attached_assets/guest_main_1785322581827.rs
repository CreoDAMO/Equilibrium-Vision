#![no_main]

use risc0_zkvm::guest::env;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StationarityInput {
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub block_hash_lo: u64,
    pub block_hash_hi: u64,
    pub difference: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct StationarityOutput {
    pub residual_fp: u64,
    pub threshold_fp: u64,
    pub block_hash_lo: u64,
    pub block_hash_hi: u64,
}

risc0_zkvm::guest::entry!(main);

fn main() {
    let input: StationarityInput = env::read();

    let sum = input
        .residual_fp
        .checked_add(input.difference)
        .expect("overflow in residual + difference");
    assert_eq!(sum, input.threshold_fp, "residual + difference != threshold");
    assert!(input.difference != 0, "difference must be non-zero");

    let output = StationarityOutput {
        residual_fp: input.residual_fp,
        threshold_fp: input.threshold_fp,
        block_hash_lo: input.block_hash_lo,
        block_hash_hi: input.block_hash_hi,
    };
    env::commit(&output);
}
