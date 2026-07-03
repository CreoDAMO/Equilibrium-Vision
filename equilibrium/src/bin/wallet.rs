/// wallet — CLI for the Equilibrium EQU wallet
///
/// Usage:
///   wallet new                           — generate a new wallet, print address
///   wallet address <keystore>            — print address from a saved keystore
///   wallet balance <keystore> <ledger>   — print EQU balance
///   wallet send <keystore> <to> <amount> <fee> <nonce> — build & print a signed tx (JSON)
///   wallet verify <tx-json>              — verify a signed tx JSON from stdin or file

use equilibrium_core::wallet::{
    Wallet, Ledger, SignedTx, address_from_hex, address_to_hex,
};
use std::{env, fs, path::Path, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        usage();
        process::exit(1);
    }

    match args[1].as_str() {
        "new" => cmd_new(),
        "address" => {
            require_args(&args, 3, "wallet address <keystore>");
            cmd_address(&args[2]);
        }
        "balance" => {
            require_args(&args, 4, "wallet balance <keystore> <ledger-json>");
            cmd_balance(&args[2], &args[3]);
        }
        "send" => {
            require_args(&args, 7, "wallet send <keystore> <to> <amount> <fee> <nonce>");
            cmd_send(&args[2], &args[3], &args[4], &args[5], &args[6]);
        }
        "verify" => {
            require_args(&args, 3, "wallet verify <tx-json-file>");
            cmd_verify(&args[2]);
        }
        _ => {
            eprintln!("Unknown command: {}", args[1]);
            usage();
            process::exit(1);
        }
    }
}

fn usage() {
    eprintln!(
        "Equilibrium Wallet (EQU)\n\
         \n\
         COMMANDS\n\
         \n\
         wallet new\n\
             Generate a new wallet and save to ./wallet.json\n\
         \n\
         wallet address <keystore>\n\
             Print the address stored in <keystore>\n\
         \n\
         wallet balance <keystore> <ledger-json>\n\
             Print the EQU balance of the wallet address\n\
         \n\
         wallet send <keystore> <to-address> <amount> <fee> <nonce>\n\
             Sign a transaction and print the JSON to stdout\n\
         \n\
         wallet verify <tx-json-file>\n\
             Verify the signature on a signed transaction JSON\n"
    );
}

fn require_args(args: &[String], n: usize, usage_hint: &str) {
    if args.len() < n {
        eprintln!("Usage: {}", usage_hint);
        process::exit(1);
    }
}

fn cmd_new() {
    let w = Wallet::generate();
    let path = Path::new("wallet.json");
    if let Err(e) = w.save(path) {
        eprintln!("Failed to save keystore: {}", e);
        process::exit(1);
    }
    println!("New wallet generated.");
    println!("  Address  : {}", address_to_hex(&w.address));
    println!("  Keystore : {}", path.display());
    println!("\n  Keep wallet.json secret — it contains your private key.");
}

fn cmd_address(keystore: &str) {
    let w = load_wallet(keystore);
    println!("{}", address_to_hex(&w.address));
}

fn cmd_balance(keystore: &str, ledger_path: &str) {
    let w = load_wallet(keystore);
    let ledger = load_ledger(ledger_path);
    let bal = ledger.balance(&w.address);
    println!("{} EQU  (address: {})", bal, address_to_hex(&w.address));
}

fn cmd_send(keystore: &str, to_hex: &str, amount_s: &str, fee_s: &str, nonce_s: &str) {
    let w = load_wallet(keystore);

    let to = address_from_hex(to_hex).unwrap_or_else(|_| {
        eprintln!("Invalid recipient address: {}", to_hex);
        process::exit(1);
    });
    let amount: u64 = amount_s.parse().unwrap_or_else(|_| {
        eprintln!("Invalid amount: {}", amount_s);
        process::exit(1);
    });
    let fee: u64 = fee_s.parse().unwrap_or_else(|_| {
        eprintln!("Invalid fee: {}", fee_s);
        process::exit(1);
    });
    let nonce: u64 = nonce_s.parse().unwrap_or_else(|_| {
        eprintln!("Invalid nonce: {}", nonce_s);
        process::exit(1);
    });

    let tx = w.sign_tx(to, amount, fee, nonce);
    let json = serde_json::to_string_pretty(&tx).unwrap();
    println!("{}", json);
    eprintln!("Tx hash: {}", hex::encode(tx.hash()));
}

fn cmd_verify(tx_path: &str) {
    let raw = fs::read_to_string(tx_path).unwrap_or_else(|e| {
        eprintln!("Cannot read {}: {}", tx_path, e);
        process::exit(1);
    });
    let tx: SignedTx = serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("Invalid transaction JSON: {}", e);
        process::exit(1);
    });
    match tx.verify() {
        Ok(()) => {
            println!("Signature valid.");
            println!("  Hash   : {}", hex::encode(tx.hash()));
            println!("  From   : {}", address_to_hex(&tx.from));
            println!("  To     : {}", address_to_hex(&tx.to));
            println!("  Amount : {} EQU", tx.amount);
            println!("  Fee    : {} EQU", tx.fee);
            println!("  Nonce  : {}", tx.nonce);
        }
        Err(e) => {
            eprintln!("Signature INVALID: {}", e);
            process::exit(1);
        }
    }
}

fn load_wallet(path: &str) -> Wallet {
    Wallet::load(Path::new(path)).unwrap_or_else(|e| {
        eprintln!("Failed to load keystore '{}': {}", path, e);
        process::exit(1);
    })
}

fn load_ledger(path: &str) -> Ledger {
    let raw = fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("Cannot read ledger '{}': {}", path, e);
        process::exit(1);
    });
    serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("Invalid ledger JSON: {}", e);
        process::exit(1);
    })
}
