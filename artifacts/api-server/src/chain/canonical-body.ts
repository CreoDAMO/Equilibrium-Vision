import { successor, initialOmega, openedCouplings, transitionDigest, type CanonicalInputs, type Omega, type Successor } from "../../../../site/src/protocol/constitution.js";
import { asBlockNonce, blockNonce } from "../../../../site/src/protocol/domain.js";
import { omegaRecord, sealFromSuccessor, type SealedSuccessor } from "../../../../site/src/protocol/seal.js";
import type { NetworkId, TransitionEvidence, TxRecord } from "../../../../site/src/protocol/types.js";

/**
 * The artifact embodiment of the one successor.
 * A block that is not the successor does not install evidence.
 * A successor's evidence is an input to G. ChainState then copies Ω′ onto the operational body.
 */
export class CanonicalBody {
  omega: Omega;
  blocks: Array<{ hash: string; height: number; evidence: TransitionEvidence }> = [];

  constructor(network: NetworkId = "mainnet") {
    this.omega = initialOmega(network);
  }

  /**
   * Test seam. Awaited after the successor returns and before Ω is installed.
   * Production leaves it null. It is not a consensus input.
   */
  overlapBarrier: (() => Promise<void>) | null = null;

  async commit(inputs: Omit<CanonicalInputs, "wasmAfter">): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        hash: string;
        omegaRoot: string;
        stateRoot: string;
        evidenceRoot: string;
        tipHash: string;
        record: ReturnType<typeof omegaRecord>;
        digestRecord: ReturnType<typeof omegaRecord>;
        evidence: TransitionEvidence;
        reward: number;
        liquid: number;
        residual: number;
        residualFp: number;
        merkleRoot: string;
        prevHash: string;
        height: number;
        difficulty: number;
      }
  > {
    const evaluated = await this.evaluate(inputs);
    if (!evaluated.ok) return evaluated;
    if (!this.still(evaluated.before, evaluated.prevHash)) {
      return { ok: false, error: "block is not the successor" };
    }
    this.adopt(evaluated.sealed);
    return this.published(evaluated);
  }

  /**
   * Replay a block that already carries a hash. The successor is re-executed.
   * Identity is compared before Ω is assigned. A mismatch leaves Ω where it was.
   */
  async replay(block: {
    hash: string;
    evidence?: TransitionEvidence;
    transactions?: TxRecord[];
    timestamp: number;
    nonce: number | bigint;
    miner: string;
    difficulty: number;
    committedPressure?: number;
    stateRoot?: string;
    omegaRoot?: string;
    merkleRoot?: string;
    prevHash?: string;
    height?: number;
    txCount?: number;
    transitionRoot?: string;
  }): Promise<string | null> {
    if (!block.evidence) return "no evidence";
    if (block.difficulty !== this.omega.difficulty) return "difficulty is not the next difficulty";
    const listed = block.transactions?.length ?? 0;
    if (block.txCount !== undefined && block.txCount !== listed) {
      return "txCount is not the transaction set";
    }
    const nonce = typeof block.nonce === "bigint" ? blockNonce(block.nonce) : asBlockNonce(block.nonce);
    const before = this.omega;
    const claim = transitionDigest(before, {
      transactions: block.transactions ?? [],
      evidence: block.evidence,
      timestamp: block.timestamp,
      nonce,
      miner: block.miner,
      committedPressure: block.committedPressure ?? 0,
      couplings: openedCouplings(before),
      difficulty: block.difficulty,
      wasmAfter: null,
    });
    if (block.transitionRoot !== undefined && block.transitionRoot !== claim) {
      return "transition is not this input";
    }
    const evaluated = await this.evaluate({
      transactions: block.transactions ?? [],
      evidence: block.evidence,
      timestamp: block.timestamp,
      nonce,
      miner: block.miner,
      committedPressure: block.committedPressure ?? 0,
      couplings: openedCouplings(before),
      difficulty: block.difficulty,
    });
    if (!evaluated.ok) return evaluated.error;
    if (evaluated.sealed.hash !== block.hash) return "header is not the successor";
    if (block.merkleRoot !== undefined && block.merkleRoot !== evaluated.sealed.merkleRoot) {
      return "merkle root is not the transaction set";
    }
    if (block.prevHash !== undefined && block.prevHash !== evaluated.prevHash) {
      return "prevHash is not the predecessor";
    }
    if (block.height !== undefined && block.height !== evaluated.stepped.next.height) {
      return "height is not the successor height";
    }
    if (block.omegaRoot && block.omegaRoot !== evaluated.stepped.omegaRoot) {
      return "omega root does not replay";
    }
    if (block.stateRoot && block.stateRoot !== evaluated.stepped.stateRoot) {
      return "state root does not replay";
    }
    if (!this.still(evaluated.before, evaluated.prevHash)) return "block is not the successor";
    this.adopt(evaluated.sealed);
    return null;
  }

  private still(before: Omega, prevHash: string): boolean {
    return this.omega === before && this.omega.tipHash === prevHash;
  }

  private adopt(sealed: SealedSuccessor): void {
    this.omega = sealed.carried;
    this.blocks.push({ hash: sealed.hash, height: sealed.carried.height, evidence: sealed.evidence });
  }

  private published(evaluated: Extract<Awaited<ReturnType<CanonicalBody["evaluate"]>>, { ok: true }>) {
    const { sealed, stepped, prevHash, inputs } = evaluated;
    return {
      ok: true as const,
      hash: sealed.hash,
      omegaRoot: stepped.omegaRoot,
      stateRoot: stepped.stateRoot,
      evidenceRoot: sealed.evidenceRoot,
      tipHash: sealed.carried.tipHash,
      record: omegaRecord(sealed.carried),
      digestRecord: omegaRecord(sealed.digestOmega),
      evidence: sealed.evidence,
      reward: stepped.reward,
      liquid: stepped.liquid,
      residual: stepped.residual,
      residualFp: stepped.residualFp,
      merkleRoot: sealed.merkleRoot,
      prevHash,
      height: stepped.next.height,
      difficulty: inputs.difficulty,
    };
  }

  /**
   * Run the successor and seal it. This does not assign Ω.
   * A tip that moved while wasm or the overlap barrier ran is not installed.
   */
  private async evaluate(inputs: Omit<CanonicalInputs, "wasmAfter">): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        before: Omega;
        prevHash: string;
        inputs: Omit<CanonicalInputs, "wasmAfter">;
        stepped: Extract<Successor, { ok: true }>;
        sealed: SealedSuccessor;
      }
  > {
    const before = this.omega;
    const prevHash = before.tipHash;
    const stepped = await successor(before, inputs);
    if (!stepped.ok) return stepped;
    if (this.overlapBarrier) await this.overlapBarrier();
    if (!this.still(before, prevHash)) return { ok: false, error: "block is not the successor" };
    const sealed = sealFromSuccessor(before, { ...inputs, wasmAfter: null }, stepped);
    if (!this.still(before, prevHash)) return { ok: false, error: "block is not the successor" };
    return { ok: true, before, prevHash, inputs, stepped, sealed };
  }
}
