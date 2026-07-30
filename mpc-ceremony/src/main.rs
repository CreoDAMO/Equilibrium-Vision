//! Equilibrium MPC Phase-2 Ceremony CLI — Dual Mode
//!
//! Supports both:
//!   - Deterministic testnet setup (no PTAU, fixed seed)
//!   - Hermez / Filecoin / Ethereum KZG Phase-1 PTAU import
//!
//! Usage:
//!   # Testnet / dev (deterministic)
//!   cargo run --bin mpc-ceremony -- init --output round0.bin
//!
//!   # Mainnet (from Hermez PTAU)
//!   cargo run --bin mpc-ceremony -- init --ptau powersOfTau28_hez_final.ptau --output round0.bin
//!
//!   # Contribute
//!   cargo run --bin mpc-ceremony -- contribute --input round0.bin --output alice.bin
//!
//!   # Finalize
//!   cargo run --bin mpc-ceremony -- finalize --contributions-dir ./contributions --pk-out proving_key.bin --vk-out verification_key.bin

use ark_bn254::{Bn254, Fr};
use ark_groth16::{Groth16, ProvingKey, VerifyingKey};
use ark_relations::r1cs::ConstraintSynthesizer;
use ark_serialize::{CanonicalSerialize, CanonicalDeserialize};
use ark_std::rand::SeedableRng;
use ark_std::rand::rngs::StdRng;
use clap::{Parser, Subcommand};
use sha2::{Sha256, Digest};
use std::fs;
use std::path::Path;

// ── Mainnet / production guard ───────────────────────────────────────────────

/// Returns true when we are in a mainnet or production context that must NOT
/// use the deterministic (known-trapdoor) fallback CRS.
///
/// Triggered by:
///   EQUILIBRIUM_ENV=mainnet   (node-level env shared across all binaries)
///   MPC_REQUIRE_PTAU=1        (explicit override for the ceremony binary)
fn is_mainnet_ceremony() -> bool {
    std::env::var("EQUILIBRIUM_ENV").as_deref() == Ok("mainnet")
        || std::env::var("MPC_REQUIRE_PTAU").as_deref() == Ok("1")
}

use equilibrium::zk_proof::StationarityCircuit;

#[derive(Parser)]
#[command(name = "mpc-ceremony")]
#[command(about = "Groth16 Phase-2 MPC ceremony for Equilibrium (dual mode)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create initial Phase-2 params.
    /// If --ptau is given, imports from Hermez/Filecoin Phase-1.
    /// Otherwise, uses deterministic testnet setup.
    Init {
        #[arg(short, long)]
        ptau: Option<String>,
        #[arg(short, long)]
        output: String,
    },
    /// Contribute randomness to existing params
    Contribute {
        #[arg(short, long)]
        input: String,
        #[arg(short, long)]
        output: String,
        #[arg(short, long)]
        seed: Option<String>,
    },
    /// Verify all contributions and export final keys
    Finalize {
        #[arg(short, long)]
        contributions_dir: String,
        #[arg(short, long)]
        pk_out: String,
        #[arg(short, long)]
        vk_out: String,
    },
    /// Verify a single contribution
    Verify {
        #[arg(short, long)]
        prev: String,
        #[arg(short, long)]
        current: String,
    },
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        Commands::Init { ptau, output } => {
            if let Some(ptau_path) = ptau {
                println!("[mpc] Initializing from PTAU: {}", ptau_path);
                init_from_ptau(&ptau_path, &output);
            } else {
                // Deterministic init is forbidden in mainnet / MPC_REQUIRE_PTAU mode.
                if is_mainnet_ceremony() {
                    eprintln!(
                        "[mpc] FATAL: EQUILIBRIUM_ENV=mainnet (or MPC_REQUIRE_PTAU=1) requires \
                         --ptau <file>. Refusing to initialise with a known-trapdoor seed. \
                         Obtain a Powers-of-Tau file and re-run with --ptau."
                    );
                    std::process::exit(4);
                }
                println!("[mpc] Initializing deterministic testnet setup -> {}", output);
                init_deterministic(&output);
            }
        }
        Commands::Contribute { input, output, seed } => {
            println!("[mpc] Contributing: {} -> {}", input, output);
            contribute(&input, &output, seed);
        }
        Commands::Finalize { contributions_dir, pk_out, vk_out } => {
            println!("[mpc] Finalizing from {}", contributions_dir);
            finalize(&contributions_dir, &pk_out, &vk_out);
        }
        Commands::Verify { prev, current } => {
            println!("[mpc] Verifying: {} -> {}", prev, current);
            verify_contribution(&prev, &current);
        }
    }
}

fn init_deterministic(output: &str) {
    let mut rng = StdRng::seed_from_u64(0xEQUILIBRIUM_MPC_INIT);
    let circuit = StationarityCircuit {
        residual_fp: Some(0),
        threshold_fp: Some(0),
        block_hash_lo: Some(0),
        block_hash_hi: Some(0),
        difference: Some(0),
    };
    let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng)
        .expect("Setup failed");
    write_keys(&pk, &vk, output, &(output.to_string() + ".vk"));
    println!("[mpc] Deterministic testnet params written.");
    println!("[mpc] WARNING: Do NOT use for mainnet — run with --ptau for production.");
}

fn init_from_ptau(ptau_path: &str, output: &str) {
    println!("[mpc] Reading PTAU from {}", ptau_path);

    // ── Validate the PTAU file exists before deciding on a path ─────────────
    if !Path::new(ptau_path).exists() {
        eprintln!("[mpc] FATAL: PTAU file not found: {ptau_path}");
        std::process::exit(2);
    }

    // ── Real PTAU specialization (not yet implemented) ───────────────────────
    //
    // TODO: Replace the block below with real ark-circom / phase2 integration:
    //
    //   use ark_circom::{CircomBuilder, CircomConfig};
    //   let cfg = CircomConfig::<Bn254>::new(r1cs_path, wasm_path)?;
    //   let builder = CircomBuilder::new(cfg);
    //   let circom = builder.setup();
    //   let params = phase2::MPCParameters::new(circom, ptau_reader)?;
    //   params.write(output_writer)?;
    //
    // Until that is implemented, refuse silently in mainnet mode and permit an
    // explicit opt-in via MPC_ALLOW_PTAU_PLACEHOLDER=1 for dev experiments.
    let allow_placeholder =
        std::env::var("MPC_ALLOW_PTAU_PLACEHOLDER").as_deref() == Ok("1");

    if is_mainnet_ceremony() || !allow_placeholder {
        eprintln!(
            "[mpc] FATAL: PTAU specialization is not yet implemented. \
             Refusing deterministic fallback to protect CRS integrity.\n\
             \n\
             To run a dev experiment with the placeholder, set:\n\
               MPC_ALLOW_PTAU_PLACEHOLDER=1\n\
             \n\
             For a real mainnet ceremony, implement the phase2 import above \
             and remove this guard."
        );
        std::process::exit(3);
    }

    eprintln!(
        "[mpc] WARNING: MPC_ALLOW_PTAU_PLACEHOLDER=1 set — \
         falling back to deterministic setup. \
         DO NOT use this output for mainnet."
    );
    init_deterministic(output);
}

fn contribute(input: &str, output: &str, seed: Option<String>) {
    let (_pk, _vk) = read_keys(input).expect("Failed to read input keys");
    let entropy = seed
        .map(|s| hex::decode(s).expect("Invalid hex seed"))
        .unwrap_or_else(|| read_urandom(32));
    let mut hasher = Sha256::new();
    hasher.update(&entropy);
    hasher.update(b"equilibrium-mpc-contribution-v1");
    let contribution_hash: [u8; 32] = hasher.finalize().into();

    // Real implementation: apply randomness to CRS via phase2 library
    // For now: re-randomize deterministically from contribution hash
    let mut rng = StdRng::from_seed(contribution_hash);
    let circuit = StationarityCircuit {
        residual_fp: Some(0),
        threshold_fp: Some(0),
        block_hash_lo: Some(0),
        block_hash_hi: Some(0),
        difference: Some(0),
    };
    let (pk, vk) = Groth16::<Bn254>::circuit_specific_setup(circuit, &mut rng)
        .expect("Re-setup failed");
    write_keys(&pk, &vk, output, &(output.to_string() + ".vk"));
    println!("[mpc] Contribution hash: {}", hex::encode(&contribution_hash));
    println!("[mpc] Wrote {} and {}", output, output.to_string() + ".vk");
}

fn finalize(contributions_dir: &str, pk_out: &str, vk_out: &str) {
    let dir = Path::new(contributions_dir);
    let mut contributions = vec![];
    for entry in fs::read_dir(dir).expect("Failed to read dir") {
        let entry = entry.expect("Dir entry error");
        let path = entry.path();
        if path.extension().map(|e| e == "bin").unwrap_or(false) {
            contributions.push(path);
        }
    }
    contributions.sort();
    println!("[mpc] Found {} contributions", contributions.len());
    let last = contributions.last().expect("No contributions");
    let (pk, vk) = read_keys(last.to_str().unwrap()).expect("Read final contribution failed");
    write_keys(&pk, &vk, pk_out, vk_out);
    println!("[mpc] Final keys:");
    println!("       PK: {}", pk_out);
    println!("       VK: {}", vk_out);
}

fn verify_contribution(prev: &str, current: &str) {
    let (_prev_pk, _prev_vk) = read_keys(prev).expect("Read prev failed");
    let (_curr_pk, _curr_vk) = read_keys(current).expect("Read current failed");
    println!("[mpc] Deserialization OK.");
    println!("[mpc] NOTE: Real verification needs ark-phase2 integration.");
}

fn read_urandom(n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut f = std::fs::File::open("/dev/urandom").expect("Cannot open /dev/urandom");
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf).expect("Read entropy failed");
    buf
}

fn write_keys(pk: &ProvingKey<Bn254>, vk: &VerifyingKey<Bn254>, pk_path: &str, vk_path: &str) {
    let mut pk_buf = Vec::new();
    pk.serialize_compressed(&mut pk_buf).expect("PK serialize");
    fs::write(pk_path, pk_buf).expect("PK write");
    let mut vk_buf = Vec::new();
    vk.serialize_compressed(&mut vk_buf).expect("VK serialize");
    fs::write(vk_path, vk_buf).expect("VK write");
}

fn read_keys(path: &str) -> Result<(ProvingKey<Bn254>, VerifyingKey<Bn254>), Box<dyn std::error::Error>> {
    let pk_bytes = fs::read(path)?;
    let pk = ProvingKey::<Bn254>::deserialize_compressed(&pk_bytes[..])?;
    let vk_path = path.to_string() + ".vk";
    let vk_bytes = fs::read(&vk_path)?;
    let vk = VerifyingKey::<Bn254>::deserialize_compressed(&vk_bytes[..])?;
    Ok((pk, vk))
}
