import { applySuccessor, initialOmega, admittingNonces, type CanonicalInputs, type Omega } from "./constitution";
import { slashAmount } from "./coinomics";
import { ARBITRAGE_CODE } from "./evidence";
import { activityKeys } from "./genesis";
import { NETWORKS } from "./networks";
import { signTx } from "./wallet";
import type { DependencyRow } from "./types";
import { DEFAULT_COUPLINGS } from "./types";

/**
 * EQ-17, as written. Not the formula in coinomics.ts.
 * Reward = 50,000,000 × min(1/(R + 1e-6), 1).
 */
export function statedReward(residual: number): number {
  if (!Number.isFinite(residual) || residual < 0) return 0;
  return Math.floor(50_000_000 * Math.min(1 / (residual + 1e-6), 1));
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
    const stated = statedReward(once.residual);
    rows.push({
      id: "reward",
      specifiedBy: "EQ-17",
      omegaChanges: stated !== once.reward,
      verdict: "spec-contradicts",
      detail: `EQ-17 pays ${stated.toLocaleString()} EQU at this residual. successor pays ${once.reward}. The credit is written into the ledger. Using the written rule would be a different Ω.`,
    });
    rows.push({
      id: "issuance-split",
      specifiedBy: "EQ-18 names commission. It does not give the split.",
      omegaChanges: once.liquid !== once.reward,
      verdict: once.liquid !== once.reward ? "free-changes-omega" : "fixed",
      detail: `successor pays ${once.liquid} liquid and stakes ${once.reward - once.liquid}. Paying the whole coinbase as liquid would be a different ledger. The specification does not choose.`,
    });
  }

  const tight = applySuccessor(omega, { ...inputs, timestamp: omega.tipTimestamp + 1 });
  if (tight.ok) {
    const blockTime = 1;
    const target = params.targetBlockTimeMs / 1000;
    const unbounded = Math.max(100_000, Math.floor(omega.difficulty * (target / blockTime)));
    rows.push({
      id: "difficulty-clamp",
      specifiedBy: "EQ-06 names difficulty. It does not give the clamp.",
      omegaChanges: tight.next.difficulty !== unbounded,
      verdict: tight.next.difficulty !== unbounded ? "free-changes-omega" : "fixed",
      detail: `A one-second block moves difficulty to ${tight.next.difficulty.toLocaleString()} because the executable clamps the factor to 1.2. Without that clamp it would be ${unbounded.toLocaleString()}. EQ-06 does not state the clamp.`,
    });
  }

  const burned = slashAmount(1_000_000, "double_sign");
  const otherBurn = Math.floor(1_000_000 * 0.5);
  rows.push({
    id: "slash-rate",
    specifiedBy: "EQ-18 says the kernel records stake. It does not state a rate.",
    omegaChanges: burned !== otherBurn,
    verdict: "free-changes-omega",
    detail: `A double-sign slash of 1,000,000 bonded writes ${burned.toLocaleString()} burned. A 50% rate would write ${otherBurn.toLocaleString()}. successor uses the first number. Nothing in EQ-00–EQ-21 picks it.`,
  });

  const ledgerSupply = [...omega.ledger.values()].reduce((s, a) => s + a.balance, 0);
  const statedSupply = 100_000_000;
  rows.push({
    id: "genesis-supply",
    specifiedBy: "EQ-17 and genesis.json say 100,000,000",
    omegaChanges: ledgerSupply !== statedSupply,
    verdict: ledgerSupply === statedSupply ? "fixed" : "spec-contradicts",
    detail:
      ledgerSupply === statedSupply
        ? "The initial ledger matches the stated 100,000,000."
        : `The executable's initial ledger is ${ledgerSupply.toLocaleString()} EQU. genesis.json and EQ-17 say ${statedSupply.toLocaleString()}. The difference is treasury, actor, miner, and validator balances the specification does not list. Ω0 is not the Ω0 the spec names.`,
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
  rows.push({
    id: "wasm-host",
    specifiedBy: "EQ-06 names the account ledger as the monetary state. It does not name the wasm host.",
    omegaChanges: wasm1.ok && wasm2.ok && wasm1.omegaRoot !== wasm2.omegaRoot,
    verdict: "spec-contradicts",
    detail:
      wasm1.ok && wasm2.ok && wasm1.omegaRoot !== wasm2.omegaRoot
        ? "Two host results, two Ω. successor binds the call to one wasm hash, but EQ-06 does not name that hash or the host. The host is a choice that changes Ω until the specification names it."
        : "The wasm host comparison did not separate Ω.",
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
