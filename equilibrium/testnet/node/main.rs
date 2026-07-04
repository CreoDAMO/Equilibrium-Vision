use equilibrium_core::{
    stationary_solver::StationarySolver,
    chain_state::{BlockHeader, ChainState, compute_coinbase_reward},
    wallet::{Wallet, Ledger, address_to_hex},
};

#[tokio::main]
async fn main() {
    println!("=== Equilibrium Testnet Node ===\n");

    // ── Wallets ────────────────────────────────────────────────────────────────
    let miner  = Wallet::generate();
    let alice  = Wallet::generate();
    let bob    = Wallet::generate();

    println!("Miner : {}", address_to_hex(&miner.address));
    println!("Alice : {}", address_to_hex(&alice.address));
    println!("Bob   : {}", address_to_hex(&bob.address));
    println!();

    // ── Mine a block ───────────────────────────────────────────────────────────
    let solver = StationarySolver::new(1_000_000, 1e-8, 0.01, 2);
    let header = BlockHeader {
        prev_hash:       [0u8; 32],
        merkle_root:     [1u8; 32],
        timestamp:       1_700_000_000,
        nonce:           0,
        difficulty:      1_000_000,
        recursion_depth: 2,
        residual:        0,
    };
    let state = ChainState::default();

    println!("Mining block...");
    if let Some((solution, _txs)) = solver.optimize_full(header, vec![], &state) {
        println!("Block found  : nonce={}, residual={}", solution.nonce, solution.residual);

        // ── Coinbase reward to miner ───────────────────────────────────────────
        let reward = compute_coinbase_reward(50_000_000, solution.residual);
        let mut ledger = Ledger::new();
        ledger.credit(&miner.address, reward);
        println!("Coinbase     : {reward} EQU → miner\n");

        // ── Alice gets a grant from the miner ─────────────────────────────────
        let miner_nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        let fund_alice = miner.sign_tx(alice.address, 10_000_000, 1_000, miner_nonce);
        match ledger.apply_tx(&fund_alice) {
            Ok(()) => println!("Transfer OK  : miner → alice, 10_000_000 EQU"),
            Err(e) => println!("Transfer ERR : {e}"),
        }

        // ── Alice sends to Bob ─────────────────────────────────────────────────
        let alice_nonce = 0u64;
        let alice_to_bob = alice.sign_tx(bob.address, 3_000_000, 500, alice_nonce);
        match ledger.apply_tx(&alice_to_bob) {
            Ok(()) => println!("Transfer OK  : alice → bob,  3_000_000 EQU"),
            Err(e) => println!("Transfer ERR : {e}"),
        }

        // ── Replay protection: same nonce should fail ──────────────────────────
        let replay = alice.sign_tx(bob.address, 1_000, 100, alice_to_bob.nonce);
        match ledger.apply_tx(&replay) {
            Ok(())  => println!("Replay PASSED (BUG)"),
            Err(e)  => println!("Replay blocked: {e}"),
        }

        // ── Balances ───────────────────────────────────────────────────────────
        println!("\n── Final balances ──────────────────────────────");
        println!("Miner : {} EQU", ledger.balance(&miner.address));
        println!("Alice : {} EQU", ledger.balance(&alice.address));
        println!("Bob   : {} EQU", ledger.balance(&bob.address));

        // ── Verify transaction signature ───────────────────────────────────────
        println!("\n── Signature verification ──────────────────────");
        match alice_to_bob.verify() {
            Ok(())  => println!("alice→bob tx: signature valid ✓"),
            Err(e)  => println!("alice→bob tx: INVALID — {e}"),
        }
    } else {
        println!("No block found.");
    }
}
