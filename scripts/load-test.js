/**
 * Equilibrium Load-Test Harness (k6)
 *
 * Submits real signed transactions and block headers using ephemeral
 * Ed25519 keypairs derived in-VU via the WebCrypto API (k6 ≥ 0.46).
 *
 * Run:
 *   k6 run --vus 50 --duration 60s scripts/load-test.js \
 *       -e BASE_URL=https://<your-repl>.replit.dev
 *
 * Metrics reported:
 *   - http_req_duration (p95, p99)
 *   - tx_submit_ok_rate
 *   - tx_submit_fail_rate
 *   - blocks_submitted
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ── Custom metrics ────────────────────────────────────────────────────────────
const txOk        = new Counter("tx_submit_ok");
const txFail      = new Counter("tx_submit_fail");
const txOkRate    = new Rate("tx_submit_ok_rate");
const blockOk     = new Counter("blocks_submitted");
const txLatency   = new Trend("tx_latency_ms", true);

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const API      = `${BASE_URL}/api`;

export const options = {
  scenarios: {
    tx_flood: {
      executor: "constant-vus",
      vus: 50,
      duration: "60s",
      tags: { scenario: "tx_flood" },
    },
    block_submit: {
      executor: "constant-arrival-rate",
      rate: 4,          // ~1 block / 15 s across 4 rps keeps it realistic
      timeUnit: "1m",
      duration: "60s",
      preAllocatedVUs: 2,
      tags: { scenario: "block_submit" },
    },
  },
  thresholds: {
    tx_submit_ok_rate: ["rate>0.95"],
    http_req_duration: ["p(95)<2000"],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert an ArrayBuffer to a lowercase hex string. */
function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive an Equilibrium address from a raw Ed25519 public key.
 * Matches Rust: SHA-256(pubkey_bytes)[..20] as 40 hex chars.
 */
async function deriveAddress(pubKeyBuf) {
  const hash = await crypto.subtle.digest("SHA-256", pubKeyBuf);
  return bufToHex(hash).slice(0, 40);
}

/**
 * Generate an ephemeral Ed25519 keypair via WebCrypto and derive the address.
 * Returns { privKey, pubKeyHex, address }.
 */
async function generateWallet() {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const pubKeyBuf = await crypto.subtle.exportKey("raw", kp.publicKey);
  const pubKeyHex = bufToHex(pubKeyBuf);
  const address   = await deriveAddress(pubKeyBuf);
  return { privKey: kp.privateKey, pubKeyHex, address };
}

/**
 * Sign the canonical Equilibrium transaction message:
 * UTF-8( from + to + amount + fee + nonce )
 * Returns signature hex.
 */
async function signTx(privKey, from, to, amount, fee, nonce) {
  const msg = new TextEncoder().encode(`${from}${to}${amount}${fee}${nonce}`);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privKey, msg);
  return bufToHex(sigBuf);
}

// ── VU state (generated once per VU) ─────────────────────────────────────────
let vuWallet = null;
let faucetFunded = false;

async function ensureWallet() {
  if (!vuWallet) {
    vuWallet = await generateWallet();
  }
}

/**
 * Fund the VU wallet from the faucet (best-effort; faucet has a cooldown).
 */
function fundFromFaucet(address) {
  const res = http.post(
    `${API}/faucet`,
    JSON.stringify({ address, amount: 10_000_000 }),
    { headers: { "Content-Type": "application/json" } },
  );
  return res.status === 200;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

export default async function () {
  await ensureWallet();
  const { privKey, pubKeyHex, address } = vuWallet;

  // Fund once per VU
  if (!faucetFunded) {
    faucetFunded = fundFromFaucet(address);
    sleep(0.5);
    return;
  }

  // ── Transaction submission ───────────────────────────────────────────────
  const to     = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // burn address
  const amount = 1;
  const fee    = 100;
  const nonce  = Math.floor(Math.random() * 1_000_000);

  const signature = await signTx(privKey, address, to, amount, fee, nonce);

  const payload = JSON.stringify({
    from: address,
    to,
    amount,
    fee,
    nonce,
    signature,
    publicKey: pubKeyHex,
  });

  const start = Date.now();
  const res = http.post(`${API}/tx/broadcast`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "tx_broadcast" },
  });
  txLatency.add(Date.now() - start);

  const ok = check(res, {
    "tx accepted (200)": r => r.status === 200,
    "response has txHash": r => {
      try { return !!JSON.parse(r.body).txHash; } catch { return false; }
    },
  });

  if (ok) {
    txOk.add(1);
    txOkRate.add(true);
  } else {
    txFail.add(1);
    txOkRate.add(false);
  }

  sleep(0.1 + Math.random() * 0.4);
}

/**
 * Block submission scenario — submit a simulated solved header.
 * Uses the miner seed address to match genesis funding.
 */
export async function block_submit() {
  const minerAddress = "f".repeat(40); // placeholder; replace with real miner addr
  const nonce        = Math.floor(Math.random() * 2 ** 32);
  const timestamp    = Math.floor(Date.now() / 1000);

  // Minimal block header payload accepted by POST /api/blocks/submit
  const payload = JSON.stringify({
    minerAddress,
    nonce,
    timestamp,
    // residual near the target threshold so it passes validation
    residual: 5e-9 + Math.random() * 4.9e-9,
    recursionDepth: 3,
  });

  const res = http.post(`${API}/blocks/submit`, payload, {
    headers: { "Content-Type": "application/json" },
    tags: { name: "block_submit" },
  });

  check(res, { "block accepted (200)": r => r.status === 200 });
  if (res.status === 200) blockOk.add(1);

  sleep(1);
}

export function handleSummary(data) {
  const okCount   = data.metrics.tx_submit_ok?.values?.count ?? 0;
  const failCount = data.metrics.tx_submit_fail?.values?.count ?? 0;
  const total     = okCount + failCount;
  const tps       = total / (data.state.testRunDurationMs / 1000);
  const p95       = data.metrics.tx_latency_ms?.values?.["p(95)"] ?? "n/a";
  const p99       = data.metrics.tx_latency_ms?.values?.["p(99)"] ?? "n/a";

  console.log("─".repeat(60));
  console.log(`Equilibrium Load Test — Summary`);
  console.log(`  Total TX submitted : ${total}`);
  console.log(`  Accepted           : ${okCount}`);
  console.log(`  Rejected           : ${failCount}`);
  console.log(`  TPS (sustained)    : ${tps.toFixed(2)}`);
  console.log(`  Latency p95 / p99  : ${p95} ms / ${p99} ms`);
  console.log(`  Blocks submitted   : ${data.metrics.blocks_submitted?.values?.count ?? 0}`);
  console.log("─".repeat(60));

  return { stdout: "" };
}
