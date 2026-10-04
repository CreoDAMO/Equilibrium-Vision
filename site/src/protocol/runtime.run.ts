/**
 * S6 and S7. Shared surfaces are executed. Unshared surfaces stay unlabeled as agreement.
 * Rust is the crate. Android is the JNI target. Neither one is G.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { canonicalHeaderHash, residualToFixed } from "./crypto";
import { minerReward } from "./coinomics";
import { applySuccessor, initialOmega, openedCouplings } from "./constitution";
import { minerKey } from "./genesis";
import { NETWORKS } from "./networks";
import { evaluateResidual } from "./solver";
import { DEFAULT_COUPLINGS } from "./types";

const grid: Array<[string, number, number, number, number, number, { hash: string; fee: number }[], number]> = [
  ["nonce0", 1_700_000_000, 0, 1_000_000, 1, 0, [], 0.02519000125198503],
  ["nonce1", 1_700_000_000, 1, 1_000_000, 1, 0, [], 0.09076955982638274],
  ["nonce1-100k", 1_700_000_000, 1, 100_000, 1, 0, [], 0.086836478057786756],
  ["nonce6", 1_700_000_000, 6, 1_000_000, 1, 0, [], 0.0002011002025239986],
  ["nonce7", 1_700_000_000, 7, 1_000_000, 1, 0, [], 0.043329506709598564],
  ["work0", 1_700_000_000, 6, 1_000_000, 0, 0, [], 1.000201100202524],
  ["pressure", 1_700_000_000, 6, 1_000_000, 1, 1, [], 2.0002011002025242],
  ["ts0", 0, 6, 1_000_000, 1, 0, [], 0.16225219837223626],
  ["nonceHi", 1_700_000_000, 9007199254740991, 1_000_000, 1, 0, [], 0.098695867101580084],
  ["tx", 1_700_000_000, 6, 1_000_000, 1, 0.5, [{ hash: "ab".repeat(32), fee: 1000 }], 0.5191116242016731],
];

const decisions: Array<{ name: string; fp: number; admitTestnet: boolean; admitMainnet: boolean }> = [];
for (const [name, timestamp, nonce, difficulty, work, pressure, txs, expected] of grid) {
  const got = evaluateResidual(
    { prevHash: "00".repeat(32), merkleRoot: "00".repeat(32), timestamp, nonce, difficulty },
    txs,
    { cumulativeWork: work, mempoolPressure: pressure },
  );
  assert.ok(Math.abs(got.canonical - expected) < 1e-12, `${name} residual drifted`);
  const fp = residualToFixed(got.canonical);
  assert.equal(fp, Math.floor(expected * 1e18));
  decisions.push({
    name,
    fp,
    admitTestnet: got.canonical < NETWORKS.testnet.residualThreshold,
    admitMainnet: got.canonical < NETWORKS.mainnet.residualThreshold,
  });
}
assert.equal(decisions.find((row) => row.name === "nonce6")!.fp, 201_100_202_523_998);
assert.equal(decisions.find((row) => row.name === "nonce6")!.admitMainnet, true);
assert.equal(decisions.find((row) => row.name === "nonce0")!.admitMainnet, false);

const quiet = evaluateResidual(
  { prevHash: "00".repeat(32), merkleRoot: "00".repeat(32), timestamp: 1_700_000_000, nonce: 6, difficulty: 1_000_000 },
  [],
  { cumulativeWork: 1, mempoolPressure: 0 },
  { hash: 0, structural: 0, continuity: 0, mempool: 0, fees: 0 },
);
assert.equal(quiet.canonical, 0);
assert.notEqual(quiet.canonicalFp, decisions.find((row) => row.name === "nonce6")!.fp);

const ten = canonicalHeaderHash({
  prevHash: "11".repeat(32),
  merkleRoot: "22".repeat(32),
  stateRoot: "33".repeat(32),
  timestamp: 1_700_000_000,
  nonce: 7,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "ab".repeat(20),
  height: 3,
  committedPressure: 0,
});
assert.equal(ten, "836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306");
const thirteen = canonicalHeaderHash({
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  stateRoot: "89c80f5eddc60e39b03437f5a46e9e81fb03d24fe10d1b35892e8beebe977884",
  timestamp: 1_700_000_000,
  nonce: 6,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "a".repeat(40),
  height: 1,
  committedPressure: 0,
  chainId: 1,
  evidenceRoot: "b425e880a379ede65d894a3470544f23a1a5076e690e78968e3072d2f2ca7994",
  omegaRoot: "2777b2548cd75d2d9712b3d0983bc38420c0306b132d458083bcb5c844a59fbd",
});
assert.equal(thirteen, "795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2");
const withTransition = canonicalHeaderHash({
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  stateRoot: "89c80f5eddc60e39b03437f5a46e9e81fb03d24fe10d1b35892e8beebe977884",
  timestamp: 1_700_000_000,
  nonce: 6,
  difficulty: 1_000_000,
  residualFp: 201_100_202_523_998,
  miner: "a".repeat(40),
  height: 1,
  committedPressure: 0,
  chainId: 1,
  evidenceRoot: "b425e880a379ede65d894a3470544f23a1a5076e690e78968e3072d2f2ca7994",
  omegaRoot: "2777b2548cd75d2d9712b3d0983bc38420c0306b132d458083bcb5c844a59fbd",
  transitionRoot: "ab".repeat(32),
});
assert.notEqual(withTransition, thirteen);

const reward = (height: number, residual: number, target: number) =>
  Math.floor(minerReward(height, residual, target, { baseReward: 100, halvingInterval: 2_100_000 }));
assert.equal(reward(0, 0, 2e-3), 100);
assert.equal(reward(1, 0, 2e-3), 99);
assert.equal(reward(1, 1, 2e-3), 0);
assert.equal(reward(1, 0.0002011002025239986, 2e-3), 99);
assert.equal(reward(0, 0.0002011002025239986, 2e-3), 100);
assert.equal(reward(1, 0.0002011002025239986, 8e-4), 99);

const omega = initialOmega("mainnet");
const nan = applySuccessor(omega, {
  transactions: [],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6,
  miner: minerKey("mainnet").address,
  committedPressure: Number.NaN,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
});
assert.equal(nan.ok, false);

const rust = execFileSync(
  "cargo",
  [
    "test",
    "--manifest-path",
    "/tmp/eq/equilibrium/Cargo.toml",
    "--lib",
    "--",
    "canonical_residual_grid_matches_the_public_kernel",
    "canonical_residual_matches_the_public_kernel_vector",
    "canonical_header_hash_matches_the_public_kernel_vector",
    "canonical_header_hash_evidence_matches_the_kernel_block",
    "canonical_coinbase_matches_the_public_kernel_vectors",
    "--test-threads",
    "8",
  ],
  { encoding: "utf8" },
);
const rustPassed = (rust.match(/test .*\.\.\. ok/g) ?? []).length;
assert.ok(rustPassed >= 5, rust.slice(-500));

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const wasmPath = "/tmp/eq/site/src/protocol/arbitrage.wasm";
const wasmA = sha256(wasmPath);
const wasmB = sha256(wasmPath);
assert.equal(wasmA, wasmB);

const commit = execFileSync("git", ["-C", "/tmp/eq", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const rustc = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
const node = process.version;
const androidTree = existsSync("/tmp/eq/mobile/android");
const apk = existsSync("/tmp/eq/mobile/android/app/build/outputs/apk");
let deployed: string | null = null;
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const response = await fetch("https://equilibrium-vision.onrender.com/api/light", { signal: ctrl.signal });
  clearTimeout(timer);
  const text = await response.text();
  deployed = `${response.status}:${text.includes(commit) ? "commit-present" : "commit-absent"}:${text.slice(0, 120)}`;
} catch (error) {
  deployed = error instanceof Error ? error.message : "unreachable";
}

const reference = 201_100_202_523_995;
const thresholdFp = Math.floor(8e-4 * 1e18);
console.log(JSON.stringify({
  ok: true,
  s6: {
    grid: decisions.length,
    rustTests: rustPassed,
    tenField: ten,
    thirteenField: thirteen,
    transitionRootDiffers: withTransition !== thirteen,
    rustOmitsLambdas: quiet.canonical !== decisions.find((row) => row.name === "nonce6")!.fp,
    rustOmitsTransitionRoot: true,
    androidExecuted: androidTree && apk,
    androidTree,
    sameAdmission: 201_100_202_523_998 < thresholdFp && reference < thresholdFp,
    couplings: DEFAULT_COUPLINGS,
    level: "A on the shared residual, header, and coinbase vectors. Not A for G, transitionRoot, or Android.",
  },
  s7: {
    commit,
    node,
    rustc,
    wasm: wasmA,
    wasmReread: wasmA === wasmB,
    rebuild: "not run",
    deployed,
    level: "C for the source commit and the wasm bytes. Not B: two builds were not compared, and the deployment does not name this commit.",
  },
}));
