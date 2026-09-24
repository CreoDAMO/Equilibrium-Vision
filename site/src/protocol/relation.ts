import { hexToBytes } from "./bytes";
import { residualToFixed } from "./crypto";
import type { BlockRecord, StationarityRelation } from "./types";

/**
 * The public inputs of the stationarity circuit, taken from this block.
 * The header hash already binds the state root. This is that relation,
 * not a Groth16 proof that the solver executed inside the circuit.
 */
export function stationarityRelation(block: BlockRecord, threshold: number): StationarityRelation {
  const residualFp = block.residualFp;
  const thresholdFp = residualToFixed(threshold);
  const difference = thresholdFp - residualFp;
  const raw = hexToBytes(block.hash);
  const hashLo = bytesToHexSafe(raw.subarray(0, 8));
  const hashHi = bytesToHexSafe(raw.subarray(8, 16));
  const ok =
    Number.isFinite(residualFp) &&
    Number.isFinite(thresholdFp) &&
    difference > 0 &&
    residualFp + difference === thresholdFp &&
    hashLo.length === 16 &&
    hashHi.length === 16;
  return { ok, residualFp, thresholdFp, difference, hashLo, hashHi };
}

function bytesToHexSafe(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
