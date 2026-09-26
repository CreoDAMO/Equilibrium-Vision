import { applySuccessor, foreignDifficultyFactor, initialOmega, admittingNonces, type CanonicalInputs, type Omega } from "./constitution";
import { slashAmount, minerReward } from "./coinomics";
import { ARBITRAGE_CODE } from "./evidence";
import { activityKeys, GENESIS_ALLOCATIONS } from "./genesis";
import { NETWORKS } from "./networks";
import { SPECS } from "./specs";
import { signTx } from "./wallet";
import type { DependencyRow } from "./types";
import { DEFAULT_COUPLINGS } from "./types";

/**
 * The reward EQ-17 names. Same curve successor pays.
 * floor(100 × (1/2)^(height / 2,100,000) × min(1, target / (R + 1e-9))).
 */
export function statedReward(height: number, residual: number, target = 2e-3): number {
  return Math.max(0, Math.floor(minerReward(height, residual, target)));
}

function baseOmega(): Omega {
  const omega = initialOmega("testnet");
  omega.height = 0;
  omega.tipTimestamp = 1_700_000_000;
  return omega;
}

function inputsFor(omega: Omega, nonce: number): CanonicalInputs {
  const miner = [...omega.validators.keys()].at(-1) ?? "miner";
  return {
    transactions: [],
    evidence: undefined,
    timestamp: omega.tipTimestamp + 15,
    nonce,
    miner,
    committedPressure: 0,
    couplings: { ...omega.couplings },
    difficulty: omega.difficulty,
    wasmAfter: null,
  };
}

function rootOf(omega: Omega, inputs: CanonicalInputs): string | null {
  const stepped = applySuccessor(omega, inputs);
  return stepped.ok ? stepped.omegaRoot : null;
}

/**
 * For each dependency of successor: the written spec either fixes it, names it
 * as an input, contradicts the executable, or leaves it as a choice.
 * A choice counts only when two values produce two Ω.
 */
export function dependencyFindings(): DependencyRow[] {
  const omega = baseOmega();
  const params = NETWORKS.testnet;
  const admitted = admittingNonces(omega, 512, omega.tipTimestamp + 15);
  const nonce = admitted[0] ?? 0;
  const inputs = inputsFor(omega, nonce);
  const once = applySuccessor(omega, inputs);
  const twice = applySuccessor(omega, inputs);
  const rows: DependencyRow[] = [];

  rows.push({
    id: "same-inputs",
    specifiedBy: "the executable, not EQ-00",
    omegaChanges: !(once.ok && twice.ok && once.omegaRoot === twice.omegaRoot),
    verdict: once.ok && twice.ok && once.omegaRoot === twice.omegaRoot ? "fixed" : "spec-contradicts",
    detail:
      once.ok && twice.ok && once.omegaRoot === twice.omegaRoot
        ? "One Ω and one input value. successor returns one Ω. EQ-00 says bodies must not redefine the protocol. It does not write this function down."
        : "successor did not return one Ω for one input.",
  });

  if (once.ok && admitted.length >= 2) {
    const other = applySuccessor(omega, { ...inputs, nonce: admitted[1]! });
    const same = other.ok && other.omegaRoot === once.omegaRoot;
    rows.push({
      id: "nonce",
      specifiedBy: "EQ-04 names a search. It does not name which nonce.",
      omegaChanges: !same,
      verdict: same ? "free-same-omega" : "free-changes-omega",
      detail: same
        ? `Nonces ${admitted[0]} and ${admitted[1]} both clear the threshold. Residuals differ (${once.residual} vs ${other.ok ? other.residual : "n/a"}). Ω does not, because quality is clipped at 1. The nonce must be fixed for the block. It is not what fixes Ω under that clip.`
        : "Two admitting nonces produced two states. The nonce is then part of what must be specified for Ω.",
    });
  }

  const otherMiner = applySuccessor(omega, { ...inputs, miner: "other-miner" });
  rows.push({
    id: "miner",
    specifiedBy: "not fixed by EQ-00–EQ-21",
    omegaChanges: once.ok && otherMiner.ok && otherMiner.omegaRoot !== once.omegaRoot,
    verdict: "input",
    detail: "The miner is not chosen by the specification. Given as an input, it selects one Ω. Left free, two miners are two states.",
  });

  const later = applySuccessor(omega, { ...inputs, timestamp: inputs.timestamp + 10_000 });
  rows.push({
    id: "timestamp",
    specifiedBy: "EQ-05 requires monotonic time. It does not pick the timestamp.",
    omegaChanges: once.ok && later.ok && later.omegaRoot !== once.omegaRoot,
    verdict: "input",
    detail: "Timestamp is an input. It is stored on Ω and it sets the next difficulty.",
  });

  const pressured = applySuccessor(omega, { ...inputs, committedPressure: 1 });
  rows.push({
    id: "pressure",
    specifiedBy: "EQ-02 names pressure as a field. It does not derive it from Ω.",
    omegaChanges: once.ok && pressured.ok && pressured.omegaRoot !== once.omegaRoot,
    verdict: once.ok && pressured.ok && pressured.omegaRoot !== once.omegaRoot ? "input" : "free-same-omega",
    detail:
      once.ok && pressured.ok && pressured.omegaRoot === once.omegaRoot
        ? "Pressure 0 and pressure 1 changed the residual and not Ω, while both rewards stayed on the clip."
        : "Pressure changed Ω. It has to be an input, or a function the specification writes down. The mempool is not that function.",
  });

  const ablated = applySuccessor(omega, {
    ...inputs,
    couplings: { ...DEFAULT_COUPLINGS, structural: 0 },
  });
  rows.push({
    id: "couplings",
    specifiedBy: "EQ-02 names the couplings. It does not fix their values.",
    omegaChanges: once.ok && ablated.ok && ablated.omegaRoot !== once.omegaRoot,
    verdict: once.ok && ablated.ok && ablated.omegaRoot !== once.omegaRoot ? "free-changes-omega" : "free-same-omega",
    detail:
      once.ok && ablated.ok && ablated.omegaRoot === once.omegaRoot
        ? "Zeroing λ_structural changed the residual and not Ω under the clip. The value still has to be an input of the block, because it changes the header."
        : "The coupling value changed Ω. Passed proposals are one way this body sets it. The specification does not require that way.",
  });

  if (once.ok) {
    const stated = statedReward(omega.height + 1, once.residual, params.residualThreshold);
    const rewardAgrees = stated === once.reward;
    rows.push({
      id: "reward",
      specifiedBy: "EQ-17",
      omegaChanges: !rewardAgrees,
      verdict: rewardAgrees ? "fixed" : "spec-contradicts",
      detail: rewardAgrees
        ? `EQ-17 and successor both pay ${once.reward} at height ${omega.height + 1} for this residual. The old 50,000,000 formula is not the rule.`
        : `EQ-17 pays ${stated}. successor pays ${once.reward}.`,
    });
    const declaredLiquid = Math.floor(once.reward * 0.1);
    const splitAgrees = once.liquid === declaredLiquid;
    rows.push({
      id: "issuance-split",
      specifiedBy: "EQ-18",
      omegaChanges: !splitAgrees,
      verdict: splitAgrees ? "fixed" : "spec-contradicts",
      detail: splitAgrees
        ? `Liquid issuance is ${once.liquid}. The remaining ${once.reward - once.liquid} is staked. That is floor(reward × 0.1), which is what EQ-18 states for this producer.`
        : `EQ-18 expects liquid ${declaredLiquid}. successor paid ${once.liquid}.`,
    });
  }

  const tight = applySuccessor(omega, { ...inputs, timestamp: omega.tipTimestamp + 1 });
  if (tight.ok) {
    const blockTime = 1;
    const target = params.targetBlockTimeMs / 1000;
    const factor = Math.max(0.8, Math.min(1.2, target / blockTime));
    const declared = Math.max(100_000, Math.floor(omega.difficulty * factor));
    rows.push({
      id: "difficulty-clamp",
      specifiedBy: "EQ-06",
      omegaChanges: tight.next.difficulty !== declared,
      verdict: tight.next.difficulty === declared ? "fixed" : "spec-contradicts",
      detail:
        tight.next.difficulty === declared
          ? `A one-second block sets difficulty to ${tight.next.difficulty.toLocaleString()}. EQ-06 clamps the factor to 1.2 and floors it at 100,000.`
          : `EQ-06 expects ${declared.toLocaleString()}. successor wrote ${tight.next.difficulty.toLocaleString()}.`,
    });
  }

  const burned = slashAmount(1_000_000, "double_sign");
  const downtime = slashAmount(1_000_000, "downtime");
  const slashAgrees = burned === 50_000 && downtime === 10_000;
  rows.push({
    id: "slash-rate",
    specifiedBy: "EQ-18",
    omegaChanges: !slashAgrees,
    verdict: slashAgrees ? "fixed" : "spec-contradicts",
    detail: slashAgrees
      ? "A double-sign of 1,000,000 bonded burns 50,000. Downtime burns 10,000. Those are the 5% and 1% rates EQ-18 states."
      : `Slash writes ${burned} and ${downtime}. EQ-18 states 50,000 and 10,000.`,
  });

  const ledgerSupply = [...omega.ledger.values()].reduce((s, a) => s + a.balance, 0);
  const allocationSupply = GENESIS_ALLOCATIONS.reduce((s, a) => s + a.amount, 0);
  rows.push({
    id: "genesis-supply",
    specifiedBy: "EQ-17",
    omegaChanges: false,
    verdict: "fixed",
    detail: `The seven genesis.json allocation lines sum to ${allocationSupply.toLocaleString()} EQU. The file's initial_supply header says 100,000,000, which is not that sum. This kernel credits the lines, then the treasury, the producer, three activity keys, and the genesis validators' stake, and bonds 500,000 of the producer. The initial ledger is ${ledgerSupply.toLocaleString()}. That is a wider scope than the allocation list, not a second copy of it.`,
  });

  rows.push({
    id: "finality",
    specifiedBy: "EQ-10",
    omegaChanges: false,
    verdict: params.finalityQuorum === 2 / 3 && params.finalityLag === 2 ? "fixed" : "spec-contradicts",
    detail:
      params.finalityQuorum === 2 / 3 && params.finalityLag === 2
        ? "Quorum is 2/3 and the lag is 2, which is what EQ-10 says. finalizedHeight is then a function of Ω, not a choice."
        : `Params are quorum ${params.finalityQuorum} and lag ${params.finalityLag}. EQ-10 says 2/3 and two blocks.`,
  });

  const actor = activityKeys("testnet")[0]!;
  const overdraft = signTx(actor, {
    to: "b".repeat(40),
    amount: 10_000_000_000,
    fee: 1,
    nonce: omega.ledger.get(actor.address)?.nonce ?? 0,
    chainId: omega.chainId,
    timestamp: inputs.timestamp,
  });
  const over = applySuccessor(omega, { ...inputs, transactions: [overdraft] });
  const balance = over.ok ? over.next.ledger.get(actor.address)?.balance : undefined;
  rows.push({
    id: "overdraft",
    specifiedBy: "EQ-03",
    omegaChanges: over.ok && typeof balance === "number" && balance < 0,
    verdict: over.ok && typeof balance === "number" && balance < 0 ? "free-changes-omega" : "fixed",
    detail:
      over.ok && typeof balance === "number" && balance < 0
        ? `A signed transfer larger than the balance was applied. The sender's balance is ${balance.toLocaleString()}. A body that refused the overdraft would commit a different Ω.`
        : "The transition refused the unfunded transfer. The sender is unchanged, and nothing else is credited.",
  });

  const plain = baseOmega();
  const foreignOmega = baseOmega();
  foreignOmega.btc.push({
    hash: `${"ab".repeat(31)}ff`,
    height: 800_000,
    prevHash: "0".repeat(64),
    merkleRoot: "11".repeat(32),
    bits: 0x170d5d26,
  });
  const atTarget = {
    ...inputsFor(plain, nonce),
    timestamp: plain.tipTimestamp + params.targetBlockTimeMs / 1000,
  };
  const withoutForeign = applySuccessor(plain, atTarget);
  const withForeign = applySuccessor(foreignOmega, atTarget);
  if (
    withoutForeign.ok &&
    withForeign.ok &&
    withoutForeign.next.difficulty !== withForeign.next.difficulty &&
    foreignDifficultyFactor(foreignOmega).num !== foreignDifficultyFactor(foreignOmega).den
  ) {
    rows.push({
      id: "foreign-consequence",
      specifiedBy: "EQ-20",
      omegaChanges: true,
      verdict: "fixed",
      detail: `A verified Bitcoin tip changes the next difficulty, from ${withoutForeign.next.difficulty.toLocaleString()} to ${withForeign.next.difficulty.toLocaleString()}. The header is not only stored. No tip leaves the time rule unchanged.`,
    });
  } else {
    rows.push({
      id: "foreign-consequence",
      specifiedBy: "EQ-20",
      omegaChanges: false,
      verdict: "spec-contradicts",
      detail: "A Bitcoin tip did not change the next difficulty. EQ-20 says it must.",
    });
  }

  const hostA = new Map<string, string>([["owner", "a"]]);
  const hostB = new Map<string, string>([["owner", "b"]]);
  const wasmInputs = {
    ...inputs,
    evidence: {
      v: 1 as const,
      chainId: omega.chainId,
      wasmCode: ARBITRAGE_CODE,
      btc: [],
      eth: [],
      wasm: [{ method: "init" as const, caller: "a".repeat(40) }],
      stake: [],
    },
  };
  const wasm1 = applySuccessor(omega, { ...wasmInputs, wasmAfter: hostA });
  const wasm2 = applySuccessor(omega, { ...wasmInputs, wasmAfter: hostB });
  const wrongCode = applySuccessor(omega, {
    ...wasmInputs,
    evidence: { ...wasmInputs.evidence, wasmCode: "0".repeat(64) },
    wasmAfter: hostA,
  });
  const namesHost = SPECS.find((spec) => spec.id === "EQ-06")?.body.some((line) => line.includes("callArbitrage")) === true;
  const hostNamed = !wrongCode.ok && namesHost;
  rows.push({
    id: "wasm-host",
    specifiedBy: "EQ-06",
    omegaChanges: wasm1.ok && wasm2.ok && wasm1.omegaRoot !== wasm2.omegaRoot,
    verdict: hostNamed ? "fixed" : "spec-contradicts",
    detail: hostNamed
      ? `The host is callArbitrage over ${ARBITRAGE_CODE}. A different code is refused (${wrongCode.ok ? "accepted" : wrongCode.error}). Two storage maps are two Ω because that map is the output of this host.`
      : "The wasm host is still unnamed, or a different code was accepted.",
  });

  const lag = params.finalityLag;
  rows.push({
    id: "outside",
    specifiedBy: "not an input of successor",
    omegaChanges: false,
    verdict: "fixed",
    detail: `Mempool membership, peers, Date, and the search iterations are not read by successor. They can choose an input (a timestamp, a nonce, a transaction list). They are not themselves Ω. Finality lag used by the executable is ${lag}.`,
  });

  return rows;
}
