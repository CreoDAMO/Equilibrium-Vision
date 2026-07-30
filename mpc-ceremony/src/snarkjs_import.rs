//! snarkjs verification_key.json + zkey → ark-groth16 compressed PK/VK (BN254)
//!
//! VK JSON shape (snarkjs `zkey export verificationkey`):
//! {
//!   "protocol": "groth16",
//!   "curve": "bn128",
//!   "nPublic": N,
//!   "vk_alpha_1": ["x","y","1"],
//!   "vk_beta_2":  [["x0","x1"],["y0","y1"],["1","0"]],
//!   "vk_gamma_2": ...,
//!   "vk_delta_2": ...,
//!   "IC": [ ["x","y","1"], ... ]   // length = nPublic + 1
//! }
//!
//! NOTE: This module handles G1/G2 from JSON (big-endian decimal/hex strings, normal form).
//! For zkey binary parsing use `zkey_pk` which handles Montgomery form correctly.

use ark_bn254::{Bn254, Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{PrimeField, Zero};
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_serialize::CanonicalSerialize;
use num_bigint::BigUint;
use num_traits::Num;
use serde::Deserialize;
use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, Deserialize)]
pub struct SnarkjsVkJson {
    pub protocol: Option<String>,
    pub curve: Option<String>,
    #[serde(rename = "nPublic")]
    pub n_public: Option<u32>,
    pub vk_alpha_1: Vec<String>,
    pub vk_beta_2: Vec<Vec<String>>,
    pub vk_gamma_2: Vec<Vec<String>>,
    pub vk_delta_2: Vec<Vec<String>>,
    #[serde(rename = "IC")]
    pub ic: Vec<Vec<String>>,
}

fn fq_from_dec(s: &str) -> Result<Fq, String> {
    let s = s.trim();
    // snarkjs sometimes writes hex with 0x
    let bi = if let Some(h) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        BigUint::from_str_radix(h, 16).map_err(|e| format!("hex fq: {e}"))?
    } else {
        BigUint::from_str(s).map_err(|e| format!("dec fq: {e}"))?
    };
    let bytes = bi.to_bytes_be();
    Ok(Fq::from_be_bytes_mod_order(&bytes))
}

fn g1_from_snarkjs(coords: &[String]) -> Result<G1Affine, String> {
    if coords.len() < 2 {
        return Err(format!("G1 needs ≥2 coords, got {}", coords.len()));
    }
    let x = fq_from_dec(&coords[0])?;
    let y = fq_from_dec(&coords[1])?;
    let p = G1Affine::new_unchecked(x, y);
    if !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
        // try as zero
        if x.is_zero() && y.is_zero() {
            return Ok(G1Affine::zero());
        }
        return Err("G1 point not on curve / bad subgroup".into());
    }
    Ok(p)
}

/// snarkjs G2: [[x_c0, x_c1], [y_c0, y_c1], [1, 0]]
fn g2_from_snarkjs(coords: &[Vec<String>]) -> Result<G2Affine, String> {
    if coords.len() < 2 || coords[0].len() < 2 || coords[1].len() < 2 {
        return Err("G2 needs [[x0,x1],[y0,y1],...]".into());
    }
    let x = Fq2::new(fq_from_dec(&coords[0][0])?, fq_from_dec(&coords[0][1])?);
    let y = Fq2::new(fq_from_dec(&coords[1][0])?, fq_from_dec(&coords[1][1])?);
    let p = G2Affine::new_unchecked(x, y);
    if !p.is_on_curve() || !p.is_in_correct_subgroup_assuming_on_curve() {
        if x.is_zero() && y.is_zero() {
            return Ok(G2Affine::zero());
        }
        return Err("G2 point not on curve / bad subgroup".into());
    }
    Ok(p)
}

pub fn vk_from_snarkjs_json(json: &str) -> Result<VerifyingKey<Bn254>, String> {
    let parsed: SnarkjsVkJson =
        serde_json::from_str(json).map_err(|e| format!("JSON parse: {e}"))?;

    if let Some(ref p) = parsed.protocol {
        if p != "groth16" {
            return Err(format!("protocol={p}, expected groth16"));
        }
    }
    if let Some(ref c) = parsed.curve {
        let c = c.to_lowercase();
        if c != "bn128" && c != "bn254" {
            return Err(format!("curve={c}, expected bn128/bn254"));
        }
    }

    let alpha_g1 = g1_from_snarkjs(&parsed.vk_alpha_1)?;
    let beta_g2 = g2_from_snarkjs(&parsed.vk_beta_2)?;
    let gamma_g2 = g2_from_snarkjs(&parsed.vk_gamma_2)?;
    let delta_g2 = g2_from_snarkjs(&parsed.vk_delta_2)?;

    let mut gamma_abc_g1 = Vec::with_capacity(parsed.ic.len());
    for (i, pt) in parsed.ic.iter().enumerate() {
        gamma_abc_g1.push(g1_from_snarkjs(pt).map_err(|e| format!("IC[{i}]: {e}"))?);
    }
    if gamma_abc_g1.is_empty() {
        return Err("IC empty".into());
    }
    if let Some(n) = parsed.n_public {
        if gamma_abc_g1.len() != n as usize + 1 {
            return Err(format!(
                "IC len {} != nPublic+1 ({})",
                gamma_abc_g1.len(),
                n + 1
            ));
        }
    }

    Ok(VerifyingKey {
        alpha_g1,
        beta_g2,
        gamma_g2,
        delta_g2,
        gamma_abc_g1,
    })
}

pub fn write_vk_bin(vk: &VerifyingKey<Bn254>, path: &Path) -> Result<(), String> {
    let mut buf = Vec::new();
    vk.serialize_compressed(&mut buf)
        .map_err(|e| format!("serialize vk: {e}"))?;
    fs::write(path, &buf).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!(
        "[mpc] wrote {} ({} bytes, {} IC points)",
        path.display(),
        buf.len(),
        vk.gamma_abc_g1.len()
    );
    Ok(())
}

pub fn write_pk_bin(pk: &ProvingKey<Bn254>, path: &Path) -> Result<(), String> {
    let mut buf = Vec::new();
    pk.serialize_compressed(&mut buf)
        .map_err(|e| format!("serialize pk: {e}"))?;
    fs::write(path, &buf).map_err(|e| format!("write {}: {e}", path.display()))?;
    println!("[mpc] wrote {} ({} bytes)", path.display(), buf.len());
    Ok(())
}

// ── Minimal zkey reader (sections 2+3 only — VK extraction) ──────────────────
//
// For full ProvingKey including A/B/C/H query sections, use `zkey_pk::pk_from_zkey`.
// This function is kept as a lightweight VK-only path that avoids loading all query
// sections into memory.
//
// Binfile: magic "zkey" | version | nSections | sections...
// Section 2: HeaderGroth — field + nVars, nPublic, domainSize + alpha/beta/delta + IC header points
// Section 3: IC

fn read_u32_cur<R: Read>(r: &mut R) -> Result<u32, String> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u32::from_le_bytes(b))
}
fn read_u64_cur<R: Read>(r: &mut R) -> Result<u64, String> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b).map_err(|e| e.to_string())?;
    Ok(u64::from_le_bytes(b))
}

/// Uncompressed G1 as written by snarkjs (64 bytes: x||y big-endian field elems).
/// NOTE: JSON VK uses normal form; zkey binary sections use Montgomery form.
/// This reader is used only for the old lightweight zkey path — prefer `zkey_pk` for production.
fn read_g1_uncompressed_be<R: Read>(r: &mut R) -> Result<G1Affine, String> {
    let mut bx = [0u8; 32];
    let mut by = [0u8; 32];
    r.read_exact(&mut bx).map_err(|e| e.to_string())?;
    r.read_exact(&mut by).map_err(|e| e.to_string())?;
    let x = Fq::from_be_bytes_mod_order(&bx);
    let y = Fq::from_be_bytes_mod_order(&by);
    if x.is_zero() && y.is_zero() {
        return Ok(G1Affine::zero());
    }
    let p = G1Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return Err("zkey G1 not on curve".into());
    }
    Ok(p)
}

fn read_g2_uncompressed_be<R: Read>(r: &mut R) -> Result<G2Affine, String> {
    // snarkjs: x.c0 x.c1 y.c0 y.c1 (each 32 bytes BE)
    let mut buf = [0u8; 128];
    r.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let x = Fq2::new(
        Fq::from_be_bytes_mod_order(&buf[0..32]),
        Fq::from_be_bytes_mod_order(&buf[32..64]),
    );
    let y = Fq2::new(
        Fq::from_be_bytes_mod_order(&buf[64..96]),
        Fq::from_be_bytes_mod_order(&buf[96..128]),
    );
    if x.is_zero() && y.is_zero() {
        return Ok(G2Affine::zero());
    }
    let p = G2Affine::new_unchecked(x, y);
    if !p.is_on_curve() {
        return Err("zkey G2 not on curve".into());
    }
    Ok(p)
}

/// Extract verifying key from a snarkjs zkey (sections 2 + 3 only).
/// For full ProvingKey import use `zkey_pk::pk_from_zkey`.
pub fn vk_from_zkey(path: &Path) -> Result<VerifyingKey<Bn254>, String> {
    let data = fs::read(path).map_err(|e| format!("read zkey: {e}"))?;
    let mut cur = Cursor::new(data.as_slice());
    let mut magic = [0u8; 4];
    cur.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != b"zkey" {
        return Err(format!("bad zkey magic {magic:?}"));
    }
    let _ver = read_u32_cur(&mut cur)?;
    let nsec = read_u32_cur(&mut cur)?;

    let mut header_vk: Option<(G1Affine, G2Affine, G2Affine, G2Affine, u32, u32)> = None;
    let mut ic: Vec<G1Affine> = vec![];

    for _ in 0..nsec {
        let ty = read_u32_cur(&mut cur)?;
        let sz = read_u64_cur(&mut cur)? as usize;
        let mut payload = vec![0u8; sz];
        cur.read_exact(&mut payload).map_err(|e| e.to_string())?;
        let mut pcur = Cursor::new(payload.as_slice());

        match ty {
            2 => {
                // HeaderGroth: skip n8q, q, n8r, r then nVars, nPublic, domainSize
                // then alpha1, beta1, delta1, beta2, gamma2, delta2
                let n8q = read_u32_cur(&mut pcur)? as usize;
                let mut skip = vec![0u8; n8q];
                pcur.read_exact(&mut skip).map_err(|e| e.to_string())?; // q
                let n8r = read_u32_cur(&mut pcur)? as usize;
                let mut skip2 = vec![0u8; n8r];
                pcur.read_exact(&mut skip2).map_err(|e| e.to_string())?; // r
                let _n_vars = read_u32_cur(&mut pcur)?;
                let n_public = read_u32_cur(&mut pcur)?;
                let domain = read_u32_cur(&mut pcur)?;

                let alpha_g1 = read_g1_uncompressed_be(&mut pcur)?;
                let _beta_g1 = read_g1_uncompressed_be(&mut pcur)?;
                let _delta_g1 = read_g1_uncompressed_be(&mut pcur)?;
                let beta_g2 = read_g2_uncompressed_be(&mut pcur)?;
                let gamma_g2 = read_g2_uncompressed_be(&mut pcur)?;
                let delta_g2 = read_g2_uncompressed_be(&mut pcur)?;
                header_vk = Some((alpha_g1, beta_g2, gamma_g2, delta_g2, n_public, domain));
            }
            3 => {
                // IC: (nPublic+1) G1 points
                while (pcur.position() as usize) + 64 <= payload.len() {
                    ic.push(read_g1_uncompressed_be(&mut pcur)?);
                }
            }
            _ => {}
        }
    }

    let (alpha_g1, beta_g2, gamma_g2, delta_g2, n_public, _) =
        header_vk.ok_or_else(|| "zkey missing HeaderGroth (section 2)".to_string())?;
    if ic.is_empty() {
        return Err("zkey missing IC (section 3)".into());
    }
    if ic.len() != n_public as usize + 1 {
        return Err(format!(
            "IC len {} != nPublic+1 ({})",
            ic.len(),
            n_public + 1
        ));
    }

    Ok(VerifyingKey {
        alpha_g1,
        beta_g2,
        gamma_g2,
        delta_g2,
        gamma_abc_g1: ic,
    })
}
