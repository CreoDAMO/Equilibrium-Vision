//! SHA-256 of the 80-byte residual header.
//! Words stay 32 bits. A full field decomposition is not used.

use ark_bn254::Fr;
use ark_r1cs_std::fields::fp::FpVar;
use ark_r1cs_std::prelude::*;
use ark_relations::r1cs::SynthesisError;

const H0: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

type Word = [Boolean<Fr>; 32];

fn constant_word(value: u32) -> Word {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        out.push(Boolean::constant(((value >> i) & 1) == 1));
    }
    out.try_into().unwrap()
}

fn xor(a: &Word, b: &Word) -> Result<Word, SynthesisError> {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        out.push(a[i].xor(&b[i])?);
    }
    Ok(out.try_into().unwrap())
}

fn rotr(value: &Word, n: usize) -> Word {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        out.push(value[(i + n) % 32].clone());
    }
    out.try_into().unwrap()
}

fn shr(value: &Word, n: usize) -> Word {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        out.push(if i + n < 32 { value[i + n].clone() } else { Boolean::constant(false) });
    }
    out.try_into().unwrap()
}

fn add(a: &Word, b: &Word) -> Result<Word, SynthesisError> {
    let mut carry = Boolean::constant(false);
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        let axb = a[i].xor(&b[i])?;
        let sum = axb.xor(&carry)?;
        let carry_ab = a[i].and(&b[i])?;
        let carry_c = axb.and(&carry)?;
        carry = carry_ab.or(&carry_c)?;
        out.push(sum);
    }
    Ok(out.try_into().unwrap())
}

fn add_many(parts: &[Word]) -> Result<Word, SynthesisError> {
    let mut acc = parts[0].clone();
    for part in &parts[1..] {
        acc = add(&acc, part)?;
    }
    Ok(acc)
}

fn ch(e: &Word, f: &Word, g: &Word) -> Result<Word, SynthesisError> {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        let left = e[i].and(&f[i])?;
        let right = e[i].not().and(&g[i])?;
        out.push(left.xor(&right)?);
    }
    Ok(out.try_into().unwrap())
}

fn maj(a: &Word, b: &Word, c: &Word) -> Result<Word, SynthesisError> {
    let mut out = Vec::with_capacity(32);
    for i in 0..32 {
        let one = a[i].and(&b[i])?;
        let two = a[i].and(&c[i])?;
        let three = b[i].and(&c[i])?;
        out.push(one.xor(&two)?.xor(&three)?);
    }
    Ok(out.try_into().unwrap())
}

fn small0(x: &Word) -> Result<Word, SynthesisError> {
    xor(&xor(&rotr(x, 7), &rotr(x, 18))?, &shr(x, 3))
}

fn small1(x: &Word) -> Result<Word, SynthesisError> {
    xor(&xor(&rotr(x, 17), &rotr(x, 19))?, &shr(x, 10))
}

fn big0(x: &Word) -> Result<Word, SynthesisError> {
    xor(&xor(&rotr(x, 2), &rotr(x, 13))?, &rotr(x, 22))
}

fn big1(x: &Word) -> Result<Word, SynthesisError> {
    xor(&xor(&rotr(x, 6), &rotr(x, 11))?, &rotr(x, 25))
}

fn compress(state: &mut [Word; 8], block: &[Word; 16]) -> Result<(), SynthesisError> {
    let mut w = block.to_vec();
    for i in 16..64 {
        let next = add_many(&[w[i - 16].clone(), small0(&w[i - 15])?, w[i - 7].clone(), small1(&w[i - 2])?])?;
        w.push(next);
    }
    let mut a = state.clone();
    for i in 0..64 {
        let t1 = add_many(&[a[7].clone(), big1(&a[4])?, ch(&a[4], &a[5], &a[6])?, constant_word(K[i]), w[i].clone()])?;
        let t2 = add(&big0(&a[0])?, &maj(&a[0], &a[1], &a[2])?)?;
        a[7] = a[6].clone();
        a[6] = a[5].clone();
        a[5] = a[4].clone();
        a[4] = add(&a[3], &t1)?;
        a[3] = a[2].clone();
        a[2] = a[1].clone();
        a[1] = a[0].clone();
        a[0] = add(&t1, &t2)?;
    }
    for i in 0..8 {
        state[i] = add(&state[i], &a[i])?;
    }
    Ok(())
}

fn pack_byte(bits: &[Boolean<Fr>]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut acc = FpVar::<Fr>::zero();
    let mut place = FpVar::<Fr>::one();
    for bit in bits {
        acc += FpVar::conditionally_select(bit, &place, &FpVar::<Fr>::zero())?;
        place = &place + &place;
    }
    Ok(acc)
}

/// First eight digest bytes, little-endian, of an 80-byte header.
pub fn enforce_header_hash(bytes: &[FpVar<Fr>; 80]) -> Result<FpVar<Fr>, SynthesisError> {
    let mut bits = Vec::with_capacity(80);
    for byte in bytes {
        let raw = byte.to_bits_le()?;
        for bit in raw.iter().skip(8) {
            bit.enforce_equal(&Boolean::FALSE)?;
        }
        let mut word_bits = Vec::with_capacity(8);
        word_bits.extend(raw.into_iter().take(8));
        bits.push(word_bits);
    }
    let mut blocks = [[(); 16]; 2].map(|_| std::array::from_fn(|_| constant_word(0)));
    for i in 0..20 {
        let mut word = constant_word(0);
        for j in 0..4 {
            let byte = &bits[i * 4 + j];
            for k in 0..8 {
                word[(3 - j) * 8 + k] = byte[k].clone();
            }
        }
        blocks[i / 16][i % 16] = word;
    }
    blocks[1][4] = constant_word(0x8000_0000);
    blocks[1][15] = constant_word(640);
    let mut state = H0.map(constant_word);
    compress(&mut state, &blocks[0])?;
    compress(&mut state, &blocks[1])?;
    let mut hash = FpVar::<Fr>::zero();
    let mut place = FpVar::<Fr>::one();
    for limb in state.iter().take(2) {
        for byte in (0..4).rev() {
            let value = pack_byte(&limb[byte * 8..byte * 8 + 8])?;
            hash += &value * &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
            place = &place + &place;
        }
    }
    Ok(hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ark_relations::r1cs::ConstraintSystem;
    use sha2::{Digest, Sha256};

    #[test]
    fn the_second_block_header_hashes_to_the_residual_integer() {
        let mut header = [0u8; 80];
        header[64..72].copy_from_slice(&24u64.to_le_bytes());
        header[72..80].copy_from_slice(&1u64.to_le_bytes());
        let digest = Sha256::digest(header);
        let expected = u64::from_le_bytes(digest[..8].try_into().unwrap());
        assert_eq!(expected, 10_396_461_113_802_754_501);
        let cs = ConstraintSystem::<Fr>::new_ref();
        let mut bytes = Vec::with_capacity(80);
        for byte in header {
            bytes.push(FpVar::new_witness(cs.clone(), || Ok(Fr::from(byte as u64))).unwrap());
        }
        let bytes: [FpVar<Fr>; 80] = bytes.try_into().unwrap();
        let got = enforce_header_hash(&bytes).unwrap();
        got.enforce_equal(&FpVar::constant(Fr::from(expected))).unwrap();
        assert!(cs.is_satisfied().unwrap(), "{:?}", cs.which_is_unsatisfied().unwrap());
    }
}
