/**
 * snarkjs native smoke: dump-witness → wtns → groth16 prove → verify
 *
 * Usage (from repo root, after ceremony-smoke produced keys + witness):
 *   node scripts/snarkjs_smoke_test.mjs [out_dir]
 *
 * Default out_dir: ceremony-smoke-out
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

function loadSnarkjs() {
  try {
    return require("snarkjs");
  } catch {
    // global install (CI: npm i -g snarkjs)
    try {
      return require("/usr/lib/node_modules/snarkjs");
    } catch {
      // last resort: resolve via PATH-ish locations
    }
  }
  throw new Error("snarkjs not found — npm install -g snarkjs or npm i snarkjs");
}

const snarkjs = loadSnarkjs();

const OUT = process.argv[2] || "ceremony-smoke-out";
const ZKEY = join(OUT, "circuit_final.zkey");
const VK = join(OUT, "verification_key.json");
const WITNESS_BIN = join(OUT, "witness_raw.bin");
const WTNS = join(tmpdir(), "smoke_witness.wtns");

const BN254_R =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function writeLEU32(buf, offset, val) {
  buf[offset] = val & 0xff;
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

function buildWtns(witnessValues) {
  const n = witnessValues.length;
  const n8 = 32;
  const primeBuf = Buffer.alloc(32);
  let tmp = BN254_R;
  for (let i = 0; i < 32; i++) {
    primeBuf[i] = Number(tmp & 0xffn);
    tmp >>= 8n;
  }

  const sec1Data = Buffer.alloc(40);
  writeLEU32(sec1Data, 0, n8);
  primeBuf.copy(sec1Data, 4);
  writeLEU32(sec1Data, 36, n);

  const sec2Data = Buffer.alloc(n * n8);
  for (let i = 0; i < n; i++) {
    witnessValues[i].copy(sec2Data, i * n8);
  }

  const hdr = Buffer.alloc(12);
  hdr.write("wtns", 0);
  writeLEU32(hdr, 4, 2); // version
  writeLEU32(hdr, 8, 2); // nSections

  function section(type, data) {
    const sh = Buffer.alloc(12);
    writeLEU32(sh, 0, type);
    writeLEU64(sh, 4, BigInt(data.length));
    return Buffer.concat([sh, data]);
  }

  return Buffer.concat([hdr, section(1, sec1Data), section(2, sec2Data)]);
}

async function main() {
  for (const p of [ZKEY, VK, WITNESS_BIN]) {
    if (!existsSync(p)) {
      console.error(`[smoke-js] MISSING: ${p}`);
      process.exit(1);
    }
  }

  const rawWitness = readFileSync(WITNESS_BIN);
  if (rawWitness.length % 32 !== 0) {
    console.error(`[smoke-js] Witness size ${rawWitness.length} not multiple of 32`);
    process.exit(1);
  }
  const nVars = rawWitness.length / 32;
  console.log(`[smoke-js] out=\( {OUT}  witness_nVars= \){nVars}`);

  const witnessValues = [];
  for (let i = 0; i < nVars; i++) {
    witnessValues.push(rawWitness.subarray(i * 32, (i + 1) * 32));
  }

  writeFileSync(WTNS, buildWtns(witnessValues));
  console.log(`[smoke-js] wtns → ${WTNS}`);

  console.log("[smoke-js] prove …");
  let proof, publicSignals;
  try {
    ({ proof, publicSignals } = await snarkjs.groth16.prove(ZKEY, WTNS));
  } catch (e) {
    console.error("[smoke-js] PROVE FAILED:", e.message || e);
    process.exit(1);
  }
  console.log("[smoke-js] publicSignals:", publicSignals);

  const vkJson = JSON.parse(readFileSync(VK, "utf8"));
  console.log("[smoke-js] verify …");
  let valid;
  try {
    valid = await snarkjs.groth16.verify(vkJson, publicSignals, proof);
  } catch (e) {
    console.error("[smoke-js] VERIFY ERROR:", e.message || e);
    process.exit(1);
  }

  if (valid) {
    console.log("[smoke-js] PASS — snarkjs prove+verify OK");
    console.log("[smoke-js] Keys+R1CS+witness are consistent under snarkjs.");
    console.log("[smoke-js] Remaining ark failure is prove-path (CircomReduction / matrices / assignment).");
    process.exit(0);
  } else {
    console.error("[smoke-js] FAIL — snarkjs verify false");
    console.error("[smoke-js] R1CS, witness, or zkey are inconsistent.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[smoke-js] UNHANDLED:", e);
  process.exit(1);
});
