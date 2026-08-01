/**
 * snarkjs native smoke test.
 *
 * Reads the raw witness (canonical Fr values, LE 32 bytes each) produced by
 * dump-witness, wraps it in a wtns binary, then calls snarkjs groth16Prove and
 * groth16Verify using the same ceremony-smoke-out3 keys.
 *
 * If this script exits 0 the keys are sound and the issue is entirely in our
 * Rust CircomReduction.  If it exits 1 there is a key/R1CS mismatch.
 *
 * Usage:
 *   node scripts/snarkjs_smoke_test.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import snarkjs from "/home/runner/workspace/.config/npm/node_global/lib/node_modules/snarkjs/build/snarkjs.js";

const OUT = "ceremony-smoke-out3";
const ZKEY = `${OUT}/circuit_final.zkey`;
const VK   = `${OUT}/verification_key.json`;
const WITNESS_BIN = `${OUT}/witness_raw.bin`;
const WTNS = join(tmpdir(), "smoke_witness.wtns");

// ── BN254 scalar field prime ─────────────────────────────────────────────────
const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function writeLEU32(buf, offset, val) {
  buf[offset + 0] = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

function writeLEU64(buf, offset, val) {
  const lo = Number(val & 0xffffffffn);
  const hi = Number((val >> 32n) & 0xffffffffn);
  writeLEU32(buf, offset, lo);
  writeLEU32(buf, offset + 4, hi);
}

/**
 * Build a minimal .wtns binary that snarkjs can parse.
 *
 * Format (little-endian):
 *   magic "wtns" (4B) | version u32=2 | nSections u32=2
 *   Section 1 (header):
 *     type=1 u32 | size u64
 *     n8 u32=32 | prime [u8; 32] | nWitness u32
 *   Section 2 (data):
 *     type=2 u32 | size u64
 *     for each wire: value [u8; 32] LE canonical
 */
function buildWtns(witnessValues) {
  const n = witnessValues.length;
  const n8 = 32;

  // prime in LE 32 bytes
  const primeBuf = Buffer.alloc(32);
  let tmp = BN254_R;
  for (let i = 0; i < 32; i++) {
    primeBuf[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }

  // Section 1 data: n8(4) + prime(32) + nWitness(4) = 40
  const sec1Data = Buffer.alloc(40);
  writeLEU32(sec1Data, 0, n8);
  primeBuf.copy(sec1Data, 4);
  writeLEU32(sec1Data, 36, n);

  // Section 2 data: nWitness * 32
  const sec2Data = Buffer.alloc(n * n8);
  for (let i = 0; i < n; i++) {
    witnessValues[i].copy(sec2Data, i * n8);
  }

  // Outer shell
  const hdr = Buffer.alloc(12);
  hdr.write("wtns", 0, "ascii");
  writeLEU32(hdr, 4, 2);   // version
  writeLEU32(hdr, 8, 2);   // nSections

  function section(type, data) {
    const sh = Buffer.alloc(12);
    writeLEU32(sh, 0, type);
    writeLEU64(sh, 4, BigInt(data.length));
    return Buffer.concat([sh, data]);
  }

  return Buffer.concat([hdr, section(1, sec1Data), section(2, sec2Data)]);
}

async function main() {
  // ── Load raw witness bytes ─────────────────────────────────────────────────
  if (!existsSync(WITNESS_BIN)) {
    console.error(`[smoke-js] MISSING witness file: ${WITNESS_BIN}`);
    console.error("Run:  cargo run --bin dump-witness -- --output " + WITNESS_BIN);
    process.exit(1);
  }
  const rawWitness = readFileSync(WITNESS_BIN);
  const nVars = rawWitness.length / 32;
  if (rawWitness.length % 32 !== 0) {
    console.error(`[smoke-js] Witness size ${rawWitness.length} not a multiple of 32`);
    process.exit(1);
  }
  console.log(`[smoke-js] witness: ${nVars} elements`);

  const witnessValues = [];
  for (let i = 0; i < nVars; i++) {
    witnessValues.push(rawWitness.slice(i * 32, (i + 1) * 32));
  }

  // ── Write wtns file ────────────────────────────────────────────────────────
  const wtnsBuf = buildWtns(witnessValues);
  writeFileSync(WTNS, wtnsBuf);
  console.log(`[smoke-js] wrote wtns: ${WTNS} (${wtnsBuf.length} bytes)`);

  // ── Prove ─────────────────────────────────────────────────────────────────
  console.log("[smoke-js] proving with snarkjs …");
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.prove(ZKEY, WTNS));
  } catch (e) {
    console.error("[smoke-js] PROVE FAILED:", e.message);
    process.exit(1);
  }
  console.log("[smoke-js] proof generated");
  console.log("[smoke-js] public signals:", publicSignals);

  // ── Verify ────────────────────────────────────────────────────────────────
  const vkJson = JSON.parse(readFileSync(VK, "utf8"));
  console.log("[smoke-js] verifying …");
  let valid;
  try {
    valid = await snarkjs.groth16.verify(vkJson, publicSignals, proof);
  } catch (e) {
    console.error("[smoke-js] VERIFY ERROR:", e.message);
    process.exit(1);
  }

  if (valid) {
    console.log("[smoke-js] PASS — snarkjs prove+verify succeeded ✓");
    console.log("[smoke-js] The ceremony keys are sound.");
    console.log("[smoke-js] Any remaining failure is in the Rust CircomReduction witness_map.");
    process.exit(0);
  } else {
    console.error("[smoke-js] FAIL — snarkjs verify returned false");
    console.error("[smoke-js] The ceremony keys or R1CS may be inconsistent.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[smoke-js] UNHANDLED:", e);
  process.exit(1);
});
