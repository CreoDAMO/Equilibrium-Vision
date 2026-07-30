//! Vendored snarkjs zkey → ark-groth16 ProvingKey (BN254).
//!
//! Adapted from ark-circom `src/zkey.rs` (Apache-2.0 / MIT), stripped of
//! wasmer / Circom witness / NPIndex matrix paths. PK-only.
//!
//! Sections:
//!   1 Header · 2 HeaderGroth · 3 IC · 4 Coefs (skipped)
//!   5 PointsA · 6 PointsB1 · 7 PointsB2 · 8 PointsC (L) · 9 PointsH
//!
//! IMPORTANT — Montgomery form:
//! snarkjs stores Fq in **Montgomery form**. Use `Fq::new_unchecked(bigint)` —
//! NOT `Fq::from` / `from_be_bytes_mod_order` — or points will be wrong.

use ark_bn254::{Bn254, Fq, Fq2, G1Affine, G2Affine};
use ark_ec::AffineRepr;
use ark_ff::{BigInteger256, PrimeField, Zero};
use ark_groth16::{ProvingKey, VerifyingKey};
use ark_serialize::{CanonicalDeserialize, SerializationError};
use ark_std::log2;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

type IoResult<T> = Result<T, SerializationError>;

#[derive(Clone, Debug)]
struct Section {
    position: u64,
    #[allow(dead_code)]
    size: usize,
}

struct BinFile<'a, R> {
    sections: HashMap<u32, Vec<Section>>,
    reader: &'a mut R,
}

impl<'a, R: Read + Seek> BinFile<'a, R> {
    fn new(reader: &'a mut R) -> IoResult<Self> {
        let mut magic = [0u8; 4];
        reader.read_exact(&mut magic)?;
        if &magic != b"zkey" {
            return Err(SerializationError::InvalidData);
        }
        let _version = read_u32(reader)?;
        let num_sections = read_u32(reader)?;

        let mut sections: HashMap<u32, Vec<Section>> = HashMap::new();
        for _ in 0..num_sections {
            let section_id = read_u32(reader)?;
            let section_length = read_u64(reader)?;
            let pos = reader.stream_position()?;
            sections.entry(section_id).or_default().push(Section {
                position: pos,
                size: section_length as usize,
            });
            reader.seek(SeekFrom::Current(section_length as i64))?;
        }
        Ok(Self { sections, reader })
    }

    fn get_section(&self, id: u32) -> IoResult<Section> {
        self.sections
            .get(&id)
            .and_then(|v| v.first().cloned())
            .ok_or(SerializationError::InvalidData)
    }

    fn proving_key(&mut self) -> IoResult<ProvingKey<Bn254>> {
        let header = self.groth_header()?;
        let ic = self.g1_section(header.n_public + 1, 3)?;

        let a_query = self.g1_section(header.n_vars, 5)?;
        let b_g1_query = self.g1_section(header.n_vars, 6)?;
        let b_g2_query = self.g2_section(header.n_vars, 7)?;
        // L-query: private witness slots only
        let l_len = header.n_vars.saturating_sub(header.n_public).saturating_sub(1);
        let l_query = self.g1_section(l_len, 8)?;
        let h_query = self.g1_section(header.domain_size, 9)?;

        let vk = VerifyingKey::<Bn254> {
            alpha_g1: header.vk.alpha_g1,
            beta_g2: header.vk.beta_g2,
            gamma_g2: header.vk.gamma_g2,
            delta_g2: header.vk.delta_g2,
            gamma_abc_g1: ic,
        };

        Ok(ProvingKey {
            vk,
            beta_g1: header.vk.beta_g1,
            delta_g1: header.vk.delta_g1,
            a_query,
            b_g1_query,
            b_g2_query,
            h_query,
            l_query,
        })
    }

    fn groth_header(&mut self) -> IoResult<HeaderGroth> {
        let section = self.get_section(2)?;
        self.reader.seek(SeekFrom::Start(section.position))?;
        HeaderGroth::read(self.reader)
    }

    fn g1_section(&mut self, num: usize, section_id: u32) -> IoResult<Vec<G1Affine>> {
        let section = self.get_section(section_id)?;
        self.reader.seek(SeekFrom::Start(section.position))?;
        (0..num).map(|_| deserialize_g1(self.reader)).collect()
    }

    fn g2_section(&mut self, num: usize, section_id: u32) -> IoResult<Vec<G2Affine>> {
        let section = self.get_section(section_id)?;
        self.reader.seek(SeekFrom::Start(section.position))?;
        (0..num).map(|_| deserialize_g2(self.reader)).collect()
    }
}

struct ZVk {
    alpha_g1: G1Affine,
    beta_g1: G1Affine,
    beta_g2: G2Affine,
    gamma_g2: G2Affine,
    delta_g1: G1Affine,
    delta_g2: G2Affine,
}

impl ZVk {
    fn read<R: Read>(r: &mut R) -> IoResult<Self> {
        // Explicit reborrows needed: &mut R doesn't impl Copy, and struct-literal
        // field expressions don't auto-reborrow across fields.
        let alpha_g1 = deserialize_g1(r)?;
        let beta_g1 = deserialize_g1(r)?;
        let beta_g2 = deserialize_g2(r)?;
        let gamma_g2 = deserialize_g2(r)?;
        let delta_g1 = deserialize_g1(r)?;
        let delta_g2 = deserialize_g2(r)?;
        Ok(Self { alpha_g1, beta_g1, beta_g2, gamma_g2, delta_g1, delta_g2 })
    }
}

struct HeaderGroth {
    n_vars: usize,
    n_public: usize,
    domain_size: usize,
    vk: ZVk,
}

impl HeaderGroth {
    fn read<R: Read>(r: &mut R) -> IoResult<Self> {
        let _n8q = read_u32(r)?;
        let _q = BigInteger256::deserialize_uncompressed(&mut *r)?;
        let _n8r = read_u32(r)?;
        let _r2 = BigInteger256::deserialize_uncompressed(&mut *r)?;

        let n_vars = read_u32(r)? as usize;
        let n_public = read_u32(r)? as usize;
        let domain_size = read_u32(r)? as usize;
        let _power = log2(domain_size.max(1));

        let vk = ZVk::read(r)?;
        Ok(Self {
            n_vars,
            n_public,
            domain_size,
            vk,
        })
    }
}

fn read_u32<R: Read>(r: &mut R) -> IoResult<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64<R: Read>(r: &mut R) -> IoResult<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

/// snarkjs Fq is stored in Montgomery form — do NOT multiply by R again.
fn deserialize_field<R: Read>(r: &mut R) -> IoResult<Fq> {
    let bigint = BigInteger256::deserialize_uncompressed(r)?;
    Ok(Fq::new_unchecked(bigint))
}

fn deserialize_field2<R: Read>(r: &mut R) -> IoResult<Fq2> {
    Ok(Fq2::new(deserialize_field(r)?, deserialize_field(r)?))
}

fn deserialize_g1<R: Read>(r: &mut R) -> IoResult<G1Affine> {
    let x = deserialize_field(r)?;
    let y = deserialize_field(r)?;
    if x.is_zero() && y.is_zero() {
        Ok(G1Affine::identity())
    } else {
        Ok(G1Affine::new_unchecked(x, y))
    }
}

fn deserialize_g2<R: Read>(r: &mut R) -> IoResult<G2Affine> {
    let x = deserialize_field2(r)?;
    let y = deserialize_field2(r)?;
    if x.is_zero() && y.is_zero() {
        Ok(G2Affine::identity())
    } else {
        Ok(G2Affine::new_unchecked(x, y))
    }
}

/// Public API: load full ark ProvingKey (includes nested VK) from snarkjs zkey.
/// Sections loaded: 2 (HeaderGroth), 3 (IC), 5 (A), 6 (B_G1), 7 (B_G2), 8 (L/C), 9 (H).
pub fn pk_from_zkey(path: &Path) -> Result<ProvingKey<Bn254>, String> {
    let f = File::open(path).map_err(|e| format!("open zkey: {e}"))?;
    let mut reader = BufReader::new(f);
    let mut bin = BinFile::new(&mut reader).map_err(|e| format!("zkey header: {e}"))?;
    bin.proving_key()
        .map_err(|e| format!("zkey proving_key: {e}"))
}

/// Convenience: extract VK from the PK produced by the same file.
/// Prefer this over `snarkjs_import::vk_from_zkey` when you also need the PK,
/// because it reads all sections once and extracts VK from the parsed PK.
pub fn vk_from_zkey_pk(path: &Path) -> Result<VerifyingKey<Bn254>, String> {
    Ok(pk_from_zkey(path)?.vk)
}
