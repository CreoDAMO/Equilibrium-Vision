/**
 * Canonical evidence is part of the restored chain, or startup does not continue.
 * There is no partial-restore override. A body that is not the committed list
 * is not replayed. This is not a proof that a snapshot Ω is the successor.
 */
import type { BlockRecord } from "./types.js";
import { ChainState } from "./state.js";
import { verifyBlockBody } from "./block-body.js";
import { logger } from "../lib/logger.js";

export async function replayCanonicalEvidence(state: ChainState, blocks: readonly BlockRecord[]): Promise<void> {
  const failures: string[] = [];
  for (const block of blocks) {
    const chainId = block.chainId ?? block.evidence?.chainId ?? state.canonicalBody.omega.chainId;
    const verdict = verifyBlockBody(block, chainId);
    if (!verdict.ok) {
      const message = `canonical evidence body refused at height ${block.height} (${verdict.code}): ${verdict.reason}`;
      logger.error({ height: block.height, hash: block.hash, reason: message }, "canonical evidence body refused during restore");
      failures.push(`height ${block.height} ${block.hash.slice(0, 16)}: ${message}`);
      continue;
    }
    const err = await state.adoptReplay(block);
    if (err) {
      logger.error({ err, height: block.height, hash: block.hash }, "canonical evidence did not replay");
      failures.push(`height ${block.height} ${block.hash.slice(0, 16)}: ${err}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`canonical evidence replay failed for ${failures.length} block(s): ${failures.slice(0, 3).join("; ")}`);
  }
}
