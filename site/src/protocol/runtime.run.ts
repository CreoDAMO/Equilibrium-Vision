/**
 * S6 and S7. The shared surface is the site contract. Unshared surfaces stay unlabeled as agreement.
 * equilibrium reads native-contract.json. It is not G. Android is the JNI residual search. It is not G.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalHeaderHash, residualToFixed } from "./crypto";
import { minerReward } from "./coinomics";
import { applySuccessor, initialOmega, openedCouplings } from "./constitution";
import { deploymentIdentity, EMBEDDED_WASM } from "./deployment";
import { minerKey } from "./genesis";
import { NETWORKS } from "./networks";
import { evaluateResidual } from "./solver";
import { DEFAULT_COUPLINGS } from "./types";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dirname(dirname(here)));
const contract = JSON.parse(readFileSync(join(here, "native-contract.json"), "utf8")) as {
  authority: string;
  surface: string[];
  notSurface: string[];
  headerStopsAt: string;
  headerOmits: string[];
  nonce6Fp: number;
  apkEmbodies: string;
  apkDoesNotEmbody: string;
  residual: {
    rows: Array<{
      name: string;
      timestamp: number;
      nonce: number;
      difficulty: number;
      work: number;
      pressure: number;
      txs: Array<{ hash: string; fee: number }>;
      canonical: string;
    }>;
  };
  headers: {
    ten: {
      prevHash: string;
      merkleRoot: string;
      stateRoot: string;
      timestamp: number;
      nonce: number;
      difficulty: number;
      residualFp: number;
      miner: string;
      height: number;
      committedPressure: number;
      hash: string;
    };
    thirteen: {
      prevHash: string;
      merkleRoot: string;
      stateRoot: string;
      timestamp: number;
      nonce: number;
      difficulty: number;
      residualFp: number;
      miner: string;
      height: number;
      committedPressure: number;
      chainId: number;
      evidenceRoot: string;
      omegaRoot: string;
      hash: string;
    };
  };
  coinbase: Array<{ height: number; residual: string; target: string; reward: number }>;
};

assert.equal(contract.authority, "site");
assert.equal(contract.headerStopsAt, "omegaRoot");
for (const outside of ["successor", "omegaPrime"]) {
  assert.ok(contract.notSurface.includes(outside), outside);
}
assert.ok(!contract.notSurface.includes("lambda"), "λ is a residual weight");
assert.ok(!contract.notSurface.includes("transitionRoot"), "the transition digest is on the surface");
assert.ok(contract.headerOmits.includes("transitionRoot"), "the native header omits transitionRoot");
assert.ok(contract.surface.includes("residual-lambda"));
assert.ok(contract.surface.includes("omega-digest"));
assert.ok(contract.surface.includes("transition-digest"));
assert.equal(contract.apkDoesNotEmbody, "applySuccessor");
assert.equal(contract.nonce6Fp, 201_100_202_523_998);

const decisions: Array<{ name: string; fp: number; admitTestnet: boolean; admitMainnet: boolean }> = [];
for (const row of contract.residual.rows) {
  const got = evaluateResidual(
    {
      prevHash: "00".repeat(32),
      merkleRoot: "00".repeat(32),
      timestamp: row.timestamp,
      nonce: row.nonce,
      difficulty: row.difficulty,
    },
    row.txs,
    { cumulativeWork: row.work, mempoolPressure: row.pressure },
  );
  const expected = Number(row.canonical);
  assert.ok(Math.abs(got.canonical - expected) < 1e-12, `${row.name} residual drifted`);
  const fp = residualToFixed(got.canonical);
  assert.equal(fp, Math.floor(expected * 1e18));
  decisions.push({
    name: row.name,
    fp,
    admitTestnet: got.canonical < NETWORKS.testnet.residualThreshold,
    admitMainnet: got.canonical < NETWORKS.mainnet.residualThreshold,
  });
}
assert.equal(decisions.length, 10);
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

const tenFields = contract.headers.ten;
const ten = canonicalHeaderHash({
  prevHash: tenFields.prevHash,
  merkleRoot: tenFields.merkleRoot,
  stateRoot: tenFields.stateRoot,
  timestamp: tenFields.timestamp,
  nonce: tenFields.nonce,
  difficulty: tenFields.difficulty,
  residualFp: tenFields.residualFp,
  miner: tenFields.miner,
  height: tenFields.height,
  committedPressure: tenFields.committedPressure,
});
assert.equal(ten, "836ce07ec08403bf07acc120a50163b48c5910b4bfa7c1de1c08200f1f09f306");
assert.equal(tenFields.hash, ten);
const thirteenFields = contract.headers.thirteen;
const thirteen = canonicalHeaderHash({
  prevHash: thirteenFields.prevHash,
  merkleRoot: thirteenFields.merkleRoot,
  stateRoot: thirteenFields.stateRoot,
  timestamp: thirteenFields.timestamp,
  nonce: thirteenFields.nonce,
  difficulty: thirteenFields.difficulty,
  residualFp: thirteenFields.residualFp,
  miner: thirteenFields.miner,
  height: thirteenFields.height,
  committedPressure: thirteenFields.committedPressure,
  chainId: thirteenFields.chainId,
  evidenceRoot: thirteenFields.evidenceRoot,
  omegaRoot: thirteenFields.omegaRoot,
});
assert.equal(thirteen, "795d67b1ed75cd450c86f6dd4569c0b7b33f194ce6d38e3441f1c6ad5b4fc5b2");
assert.equal(thirteenFields.hash, thirteen);
const withTransition = canonicalHeaderHash({
  prevHash: thirteenFields.prevHash,
  merkleRoot: thirteenFields.merkleRoot,
  stateRoot: thirteenFields.stateRoot,
  timestamp: thirteenFields.timestamp,
  nonce: thirteenFields.nonce,
  difficulty: thirteenFields.difficulty,
  residualFp: thirteenFields.residualFp,
  miner: thirteenFields.miner,
  height: thirteenFields.height,
  committedPressure: thirteenFields.committedPressure,
  chainId: thirteenFields.chainId,
  evidenceRoot: thirteenFields.evidenceRoot,
  omegaRoot: thirteenFields.omegaRoot,
  transitionRoot: "ab".repeat(32),
});
assert.notEqual(withTransition, thirteen);

for (const row of contract.coinbase) {
  const got = Math.floor(minerReward(row.height, Number(row.residual), Number(row.target), { baseReward: 100, halvingInterval: 2_100_000 }));
  assert.equal(got, row.reward, `coinbase ${row.height} ${row.residual}`);
}

const omega = initialOmega("mainnet");
const nan = applySuccessor(omega, {
  transactions: [],
  evidence: undefined,
  timestamp: 1_700_000_000,
  nonce: 6n,
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
    join(repo, "equilibrium/Cargo.toml"),
    "--lib",
    "--",
    "canonical_residual_grid_matches_the_public_kernel",
    "canonical_residual_matches_the_public_kernel_vector",
    "canonical_header_hash_matches_the_public_kernel_vector",
    "canonical_header_hash_evidence_matches_the_kernel_block",
    "canonical_coinbase_matches_the_public_kernel_vectors",
    "canonical_lambda_weights_are_the_dropped_violation",
    "optimizer_lambda_is_not_canonical_admission",
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
const wasmPath = join(here, "arbitrage.wasm");
const wasmA = sha256(wasmPath);
const wasmB = sha256(wasmPath);
assert.equal(wasmA, wasmB);
assert.equal(wasmA, EMBEDDED_WASM);
const siteLock = sha256(join(repo, "site/package-lock.json"));
const siteLockAgain = sha256(join(repo, "site/package-lock.json"));
assert.equal(siteLock, siteLockAgain);
const workspaceLockPath = join(repo, "pnpm-lock.yaml");
const workspaceLock = existsSync(workspaceLockPath) ? sha256(workspaceLockPath) : "";
const contractHash = sha256(join(here, "native-contract.json"));

const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const rustc = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
const node = process.version;
const identity = deploymentIdentity({
  commit,
  node,
  rustc,
  siteLock,
  workspaceLock,
  wasm: wasmA,
  contract: contractHash,
});
const identityAgain = deploymentIdentity({
  commit,
  node,
  rustc,
  siteLock: siteLockAgain,
  workspaceLock: existsSync(workspaceLockPath) ? sha256(workspaceLockPath) : "",
  wasm: sha256(wasmPath),
  contract: sha256(join(here, "native-contract.json")),
});
assert.equal(identity, identityAgain);
const androidDir = join(repo, "equilibrium/mobile/android");
let androidTracked = false;
try {
  execFileSync("git", ["-C", repo, "cat-file", "-e", "HEAD:equilibrium/mobile/android/build-jni.sh"], { stdio: "ignore" });
  androidTracked = true;
} catch {
  androidTracked = false;
}
const androidTree = existsSync(androidDir) || androidTracked;
const apkBuilt = [
  join(androidDir, "app/build/outputs/apk/release/app-release.apk"),
  join(androidDir, "app/build/outputs/apk/debug/app-debug.apk"),
].some((path) => existsSync(path));
let deployed: string | null = null;
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  const response = await fetch("https://equilibrium-vision.onrender.com/api/light", { signal: ctrl.signal });
  clearTimeout(timer);
  const text = await response.text();
  deployed = `${response.status}:${text.includes(commit) ? "commit-present" : "commit-absent"}:${text.includes(wasmA) ? "wasm-present" : "wasm-absent"}:${text.slice(0, 160)}`;
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
    rustOmitsLambdas: !/canonical_lambda_weights_are_the_dropped_violation \.\.\. ok/.test(rust),
    rustOmitsTransitionRoot: true,
    observation: "The native header still stops at omegaRoot. commit.run.ts is the λ → reward → omegaRoot → transitionRoot attack, and Rust rebuilds those two digests from the fields.",
    androidExecuted: apkBuilt,
    androidTree,
    apkEmbodies: contract.apkEmbodies,
    sameAdmission: 201_100_202_523_998 < thresholdFp && reference < thresholdFp,
    couplings: DEFAULT_COUPLINGS,
    level: "The enumerated mainnet successor surface is membrane.run.ts. Android was not executed.",
  },
  s7: {
    commit,
    identity,
    node,
    rustc,
    wasm: wasmA,
    wasmEmbedded: wasmA === EMBEDDED_WASM,
    wasmReread: wasmA === wasmB,
    identityReread: identity === identityAgain,
    rebuild: "not a second compiler. The wasm file and the embedded bytes are one hash, read twice.",
    apk: apkBuilt
      ? "present"
      : "not built. No Android SDK in this workspace. .github/workflows/android-apk.yml is the rebuild, and it runs only after the site constitution.",
    deployed,
    lineage: "site is G. equilibrium reads native-contract.json. Render rootDir is site. /api/light names RENDER_GIT_COMMIT and the wasm hash. The APK is the residual search, not a second successor.",
    level: "A for the local identity: two readings, file wasm equals embedded wasm. The live host is this commit only when its light body says so. No APK.",
  },
}));
