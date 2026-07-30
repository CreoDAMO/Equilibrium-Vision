//! snarkjs / Hermez / Filecoin Powers-of-Tau (`.ptau`) reader.
//!
//! Format (iden3 binfileutils + powersoftau):
//!   Sectioned binfile:
//!     4 bytes magic "ptau"
//!     u32le version
//!     u32le nsections
//!     for each section: u32le type, u64le size, then `size` bytes payload
//!
//! Section types (snarkjs):
//!   1 = header   (n8:u32, q:n8 bytes, power:u32)
//!   2 = τ G1
//!   3 = τ G2
//!   4 = ατ G1
//!   5 = βτ G1
//!   6 = β G2
//!   7 = contributions
//!
//! This parser **streams** the file rather than loading it into memory, so
//! it works correctly on the large community PTAU files (e.g. the 100+ GB
//! Hermez power-28 file).  Only bounded prefixes of each section are hashed
//! or sampled; the rest is skipped via `io::Seek`.

use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// Maximum bytes hashed from τG1 / τG2 sections (1 MiB — sufficient for
/// fingerprinting without loading the full multi-GB payload).
const FINGERPRINT_CAP: u64 = 1 << 20;

/// Maximum bytes hashed from the contributions section.
const CONTRIBUTIONS_CAP: u64 = 4096;

/// Maximum bytes lightly bound from any other section.
const OTHER_CAP: u64 = 256;

#[derive(Debug, Clone)]
pub struct PtauInfo {
    /// log2 of domain size (e.g. 28 for powersOfTau28_hez_final)
    pub power: u32,
    /// Byte length of field element in the file (32 for BN254)
    pub n8: u32,
    /// Number of contribution records (section 7), estimated from section size
    pub n_contributions: u32,
    /// SHA-256 over header || τG1 prefix || τG2 prefix — binds setup to this file
    pub fingerprint: [u8; 32],
    /// First 32 bytes of τG1 payload (deterministic sample of powers)
    pub tau_g1_sample: [u8; 32],
    /// First 32 bytes of τG2 payload
    pub tau_g2_sample: [u8; 32],
}

#[derive(Debug)]
pub enum PtauError {
    Io(String),
    Format(String),
    TooSmall { power: u32, need: u32 },
}

impl std::fmt::Display for PtauError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PtauError::Io(s) | PtauError::Format(s) => write!(f, "{s}"),
            PtauError::TooSmall { power, need } => {
                write!(f, "PTAU power={power} too small; circuit needs ≥ {need}")
            }
        }
    }
}

fn map_io(e: io::Error, ctx: &str) -> PtauError {
    PtauError::Io(format!("{ctx}: {e}"))
}

fn read_u32_le(r: &mut impl Read) -> Result<u32, PtauError> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|e| map_io(e, "read u32"))?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64_le(r: &mut impl Read) -> Result<u64, PtauError> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).map_err(|e| map_io(e, "read u64"))?;
    Ok(u64::from_le_bytes(b))
}

/// Read exactly `n` bytes from `r` into `buf` (which is resized to `n`).
fn read_exact_buf(r: &mut impl Read, n: usize) -> Result<Vec<u8>, PtauError> {
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf).map_err(|e| map_io(e, "read section bytes"))?;
    Ok(buf)
}

/// Hash up to `cap` bytes from the current position of `r`, then skip over
/// the remaining `remaining` bytes via seek.
fn hash_prefix_and_skip<RS: Read + Seek>(
    r: &mut RS,
    hasher: &mut Sha256,
    remaining: u64,
    cap: u64,
) -> Result<(), PtauError> {
    let to_read = remaining.min(cap) as usize;
    let buf = read_exact_buf(r, to_read)?;
    hasher.update((to_read as u64).to_le_bytes());
    hasher.update(&buf);
    let leftover = remaining.saturating_sub(cap);
    if leftover > 0 {
        r.seek(SeekFrom::Current(leftover as i64))
            .map_err(|e| map_io(e, "seek past section"))?;
    }
    Ok(())
}

/// Load and validate a `.ptau` file by **streaming** — no full file load.
///
/// `min_power` is the minimum accepted ceremony size (StationarityCircuit is
/// tiny; power ≥ 10 is already enough, but we require a real community PTAU
/// so the default minimum is 20 unless overridden).
pub fn load_ptau(path: &Path, min_power: u32) -> Result<PtauInfo, PtauError> {
    let file = File::open(path).map_err(|e| map_io(e, &format!("open {}", path.display())))?;
    let file_len = file
        .metadata()
        .map_err(|e| map_io(e, "metadata"))?
        .len();
    if file_len < 16 {
        return Err(PtauError::Format("file too small to be a PTAU".into()));
    }

    let mut r = BufReader::new(file);

    // snarkjs binfile header: magic "ptau" (4) + version u32le (4) + nSections u32le (4)
    let mut magic = [0u8; 4];
    r.read_exact(&mut magic).map_err(|e| map_io(e, "magic"))?;
    if &magic != b"ptau" {
        return Err(PtauError::Format(format!(
            "bad magic {magic:x?} (expected b\"ptau\") — use a snarkjs/Hermez powersOfTau file"
        )));
    }

    let _version = read_u32_le(&mut r)?;
    let n_sections = read_u32_le(&mut r)?;
    if n_sections == 0 || n_sections > 64 {
        return Err(PtauError::Format(format!(
            "n_sections={n_sections} looks invalid"
        )));
    }

    let mut header_power: Option<u32> = None;
    let mut header_n8: Option<u32> = None;
    let mut tau_g1_sample = [0u8; 32];
    let mut tau_g2_sample = [0u8; 32];
    let mut n_contributions = 0u32;
    let mut hasher = Sha256::new();
    hasher.update(b"equilibrium-ptau-v1");
    hasher.update(&magic);

    for _ in 0..n_sections {
        let sec_type = read_u32_le(&mut r)?;
        let sec_size = read_u64_le(&mut r)?;

        match sec_type {
            1 => {
                // header: n8:u32 | q:n8 bytes | power:u32
                if sec_size < 8 {
                    return Err(PtauError::Format("header section too short".into()));
                }
                let payload = read_exact_buf(&mut r, sec_size as usize)?;
                let n8 = u32::from_le_bytes(payload[0..4].try_into().unwrap());
                if n8 != 32 {
                    return Err(PtauError::Format(format!(
                        "n8={n8} (only BN254 n8=32 supported)"
                    )));
                }
                if payload.len() < 4 + n8 as usize + 4 {
                    return Err(PtauError::Format("header missing power field".into()));
                }
                let power_off = 4 + n8 as usize;
                let power =
                    u32::from_le_bytes(payload[power_off..power_off + 4].try_into().unwrap());
                header_n8 = Some(n8);
                header_power = Some(power);
                hasher.update(&payload);
            }
            2 => {
                // τ G1 — sample first 32 bytes, then hash a bounded prefix
                let sample_len = sec_size.min(32) as usize;
                let sample_buf = read_exact_buf(&mut r, sample_len)?;
                tau_g1_sample[..sample_len].copy_from_slice(&sample_buf);
                hasher.update(&sample_buf);

                // Hash more of the section (up to FINGERPRINT_CAP) then skip the rest
                let remaining = sec_size.saturating_sub(sample_len as u64);
                hash_prefix_and_skip(&mut r, &mut hasher, remaining, FINGERPRINT_CAP.saturating_sub(sample_len as u64))?;
            }
            3 => {
                // τ G2 — same treatment as τ G1
                let sample_len = sec_size.min(32) as usize;
                let sample_buf = read_exact_buf(&mut r, sample_len)?;
                tau_g2_sample[..sample_len].copy_from_slice(&sample_buf);
                hasher.update(&sample_buf);

                let remaining = sec_size.saturating_sub(sample_len as u64);
                hash_prefix_and_skip(&mut r, &mut hasher, remaining, FINGERPRINT_CAP.saturating_sub(sample_len as u64))?;
            }
            7 => {
                // contributions — estimate count from size, hash a small prefix
                n_contributions = ((sec_size / 256).max(1)) as u32;
                hash_prefix_and_skip(&mut r, &mut hasher, sec_size, CONTRIBUTIONS_CAP)?;
            }
            _ => {
                // Lightly bind other sections to the fingerprint, then skip
                hasher.update([sec_type as u8]);
                hash_prefix_and_skip(&mut r, &mut hasher, sec_size, OTHER_CAP)?;
            }
        }
    }

    let power = header_power
        .ok_or_else(|| PtauError::Format("missing header section (type 1)".into()))?;
    let n8 = header_n8.unwrap_or(32);

    if power < min_power {
        return Err(PtauError::TooSmall {
            power,
            need: min_power,
        });
    }

    // Reject all-zero τ sample (corrupt / truncated)
    if tau_g1_sample == [0u8; 32] && tau_g2_sample == [0u8; 32] {
        return Err(PtauError::Format(
            "τ G1/G2 samples are zero — PTAU looks truncated or empty".into(),
        ));
    }

    let fingerprint: [u8; 32] = hasher.finalize().into();

    Ok(PtauInfo {
        power,
        n8,
        n_contributions,
        fingerprint,
        tau_g1_sample,
        tau_g2_sample,
    })
}
