use equilibrium_core::{
    stationary_solver::search_canonical,
    chain_state::{BlockHeader, ChainState, canonical_coinbase},
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

    // ── Mine a block on the canonical residual, not the territory residual ──
    let header = BlockHeader {
        prev_hash:       [0u8; 32],
        merkle_root:     [1u8; 32],
        timestamp:       1_700_000_000,
        nonce:           0,
        difficulty:      1_000_000,
        recursion_depth: 2,
        residual:        0,
        state_root:     [0u8; 32],
    };
    let state = ChainState {
        cumulative_work: 1,
        mempool_pressure: 0.0,
        ..ChainState::default()
    };

    println!("Mining block...");
    let (nonce, residual) = search_canonical(&header, &[], &state, 10_000, 2e-3);
    if !(residual.is_finite() && residual >= 0.0 && residual < 2e-3) {
        println!(
            "Refused: residual {residual} is not under the admission target 0.002. The search returned a candidate. That is not a block."
        );
        return;
    }
    println!("Block found  : nonce={nonce}, residual={residual}");

    let reward = canonical_coinbase(1, residual, 2e-3);
        let mut ledger = Ledger::new();
        ledger.credit(&miner.address, reward);
        println!("Coinbase     : {reward} EQU → miner\n");

        // ── Alice gets a grant from the miner ─────────────────────────────────
        // Use the ledger's tracked nonce for the miner account so this is
        // always sequentially correct and never hard-codes a value.
        let miner_nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or_else(|_| ledger.nonce(&miner.address));
        let fund_alice = miner.sign_tx(alice.address, 10_000_000, 1_000, miner_nonce);
        match ledger.apply_tx(&fund_alice) {
            Ok(()) => println!("Transfer OK  : miner → alice, 10_000_000 EQU"),
            Err(e) => println!("Transfer ERR : {e}"),
        }

        // ── Alice sends to Bob ─────────────────────────────────────────────────
        // Derive the nonce from the ledger so it is always correct regardless
        // of prior transaction history — no hard-coded value.
        let alice_nonce = ledger.nonce(&alice.address);
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
}
