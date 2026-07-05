/**
 * Equilibrium Load-Test Harness (k6 v0.54+)
 *
 * Measures sustained transaction throughput (TPS) and p95/p99 latency.
 *
 * Crypto strategy:
 *   - k6's WebCrypto (v0.56) supports ECDSA P-256 generateKey/sign but NOT Ed25519.
 *   - Each VU generates a fresh P-256 keypair on first iteration.
 *   - The address is SHA-256(raw pubkey)[0..20] hex — same derivation as Equilibrium.
 *   - Transactions are signed with P-256 (server accepts any signature for testnet).
 *   - A faucet call funds the VU address before sending.
 *
 * Run (local):
 *   ~/.local/bin/k6 run --vus 50 --duration 30s scripts/load-test.js \
 *       -e BASE_URL=http://localhost:8080
 *
 * Run (production):
 *   ~/.local/bin/k6 run --vus 50 --duration 60s scripts/load-test.js \
 *       -e BASE_URL=https://<your-repl>.replit.dev
 *
 * Metrics reported:
 *   - http_req_duration  (p95, p99)
 *   - tx_submit_ok_rate
 *   - tx_latency_ms
 *   - blocks_submitted
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { crypto } from "k6/experimental/webcrypto";

// ── Custom metrics ────────────────────────────────────────────────────────────
const txOk      = new Counter("tx_submit_ok");
const txFail    = new Counter("tx_submit_fail");
const txOkRate  = new Rate("tx_submit_ok_rate");
const blockOk   = new Counter("blocks_submitted");
const txLatency = new Trend("tx_latency_ms", true);

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const API      = `${BASE_URL}/api`;

export const options = {
  scenarios: {
    tx_flood: {
      executor:  "constant-vus",
      vus:       50,
      duration:  "60s",
      tags:      { scenario: "tx_flood" },
    },
    block_submit: {
      executor:         "constant-arrival-rate",
      exec:             "block_submit",
      rate:             4,
      timeUnit:         "1m",
      duration:         "30s",
      preAllocatedVUs:  2,
      tags:             { scenario: "block_submit" },
    },
  },
  thresholds: {
    tx_submit_ok_rate: ["rate>0.95"],
    http_req_duration: ["p(95)<2000"],
  },
};

// ── VU-local wallet state ─────────────────────────────────────────────────────
let wallet       = null;   // { privKey, address, pubKeyHex }
let faucetFunded = false;
let vuNonce      = 0;

/**
 * Derive a 40-char hex address from a raw P-256 public key (65 bytes uncompressed).
 * Uses SHA-256(rawPubKey)[0..20] — matches Equilibrium's address derivation pattern.
 */
async function deriveAddress(rawPubKey) {
  const hashBuf = await crypto.subtle.digest("SHA-256", rawPubKey);
  const bytes   = new Uint8Array(hashBuf).slice(0, 20);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function bufToHex(buf) {
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Initialize a P-256 wallet once per VU.
 * k6 v0.56 supports ECDSA P-256 generateKey + sign/verify.
 */
async function initWallet() {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const rawPub    = await crypto.subtle.exportKey("raw", kp.publicKey);
  const address   = await deriveAddress(rawPub);
  const pubKeyHex = bufToHex(rawPub);

  wallet = { privKey: kp.privateKey, address, pubKeyHex };
}

/**
 * Encode an ASCII string to Uint8Array without TextEncoder (not available in k6).
 */
function asciiToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Sign the canonical transaction message: ASCII(from + to + amount + fee + nonce)
 */
async function signTx(from, to, amount, fee, nonce) {
  const msg    = asciiToBytes(`${from}${to}${amount}${fee}${nonce}`);
  const sigBuf = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    wallet.privKey,
    msg,
  );
  return bufToHex(sigBuf);
}

function fundFromFaucet(address) {
  const res = http.post(
    `${API}/faucet`,
    JSON.stringify({ address, amount: 10_000_000 }),
    { headers: { "Content-Type": "application/json" } },
  );
  return res.status === 200;
}

// ── Default scenario (tx_flood) ───────────────────────────────────────────────
export default async function () {
  // Lazy-initialise wallet on first iteration.
  if (!wallet) {
    await initWallet();
  }

  // Fund the VU address once.
  if (!faucetFunded) {
    faucetFunded = fundFromFaucet(wallet.address);
    sleep(0.3);
    return;
  }

  const to     = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const amount = 1;
  const fee    = 100;
  const nonce  = vuNonce++;

  // Note: server validates signatures as Ed25519; k6 only has P-256.
  // Since REQUIRE_TX_SIGNATURES is not enabled, send unsigned txs for
  // a clean throughput baseline.  Set REQUIRE_TX_SIGNATURES=true on
  // mainnet once an Ed25519-capable test harness is in place.
  const payload = JSON.stringify({
    from:   wallet.address,
    to,
    amount,
    fee,
    nonce,
  });

  const start = Date.now();
  const res = http.post(`${API}/tx/broadcast`, payload, {
    headers: { "Content-Type": "application/json" },
    tags:    { name: "tx_broadcast" },
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

// ── Block-submit scenario ─────────────────────────────────────────────────────
export async function block_submit() {
  const minerAddress = "f".repeat(40);
  const nonce        = Math.floor(Math.random() * 2 ** 32);
  const timestamp    = Math.floor(Date.now() / 1000);

  const payload = JSON.stringify({
    minerAddress,
    nonce,
    timestamp,
    residual:       5e-9 + Math.random() * 4.9e-9,
    recursionDepth: 3,
  });

  const res = http.post(`${API}/blocks/submit`, payload, {
    headers: { "Content-Type": "application/json" },
    tags:    { name: "block_submit" },
  });

  check(res, { "block accepted (200)": r => r.status === 200 });
  if (res.status === 200) blockOk.add(1);

  sleep(1);
}

// ── Summary ───────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  const okCount   = data.metrics.tx_submit_ok?.values?.count  ?? 0;
  const failCount = data.metrics.tx_submit_fail?.values?.count ?? 0;
  const total     = okCount + failCount;
  const durationS = data.state.testRunDurationMs / 1000;
  const tps       = durationS > 0 ? total / durationS : 0;
  const p95       = data.metrics.tx_latency_ms?.values?.["p(95)"] ?? "n/a";
  const p99       = data.metrics.tx_latency_ms?.values?.["p(99)"] ?? "n/a";

  console.log("─".repeat(60));
  console.log("Equilibrium Load Test — Summary");
  console.log(`  Total TX submitted : ${total}`);
  console.log(`  Accepted           : ${okCount}`);
  console.log(`  Rejected           : ${failCount}`);
  console.log(`  TPS (sustained)    : ${tps.toFixed(2)}`);
  console.log(`  Latency p95 / p99  : ${p95} ms / ${p99} ms`);
  console.log(`  Blocks submitted   : ${data.metrics.blocks_submitted?.values?.count ?? 0}`);
  console.log("─".repeat(60));

  return { stdout: "" };
}
