use equilibrium_core::{
    stationary_solver::StationarySolver,
    chain_state::{BlockHeader, ChainState, TxCandidate},
};

#[tokio::main]
async fn main() {
    let solver = StationarySolver::new(1_000_000, 1e-8, 0.01, 2);
    let header = BlockHeader {
        prev_hash: [0u8; 32],
        merkle_root: [1u8; 32],
        timestamp: 1_700_000_000,
        nonce: 0,
        difficulty: 1_000_000,
        recursion_depth: 2,
        residual: 0.0,
    };
    let state = ChainState::default();
    let txs = vec![];

    if let Some((solution, _txs)) = solver.optimize_full(header, txs, &state) {
        println!("Block found: nonce = {}, residual = {}", solution.nonce, solution.residual);
    } else {
        println!("No block found.");
    }
}
