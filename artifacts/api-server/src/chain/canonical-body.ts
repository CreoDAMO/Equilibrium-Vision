import { successor, initialOmega, openedCouplings, transitionDigest } from "../../../../site/src/protocol/constitution.js";
import { asBlockNonce, blockNonce } from "../../../../site/src/protocol/domain.js";
import { omegaRecord, sealFromSuccessor } from "../../../../site/src/protocol/seal.js";
import type { CanonicalInputs, NetworkId, Omega, TransitionEvidence, TxRecord } from "../../../../site/src/protocol/types.js";

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
    const prevHash = this.omega.tipHash;
    const stepped = await successor(this.omega, inputs);
    if (!stepped.ok) return stepped;
    const sealed = sealFromSuccessor(this.omega, { ...inputs, wasmAfter: null }, stepped);
    const digestRecord = omegaRecord(sealed.digestOmega);
    const record = omegaRecord(sealed.carried);
    this.omega = sealed.carried;
    this.blocks.push({ hash: sealed.hash, height: sealed.carried.height, evidence: sealed.evidence });
    return {
      ok: true,
      hash: sealed.hash,
      omegaRoot: stepped.omegaRoot,
      stateRoot: stepped.stateRoot,
      evidenceRoot: sealed.evidenceRoot,
      tipHash: sealed.carried.tipHash,
      record,
      digestRecord,
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
   * Replay a block that already carries a hash. The successor is re-executed.
   * A mismatch refuses the block and does not move Ω.
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
    transitionRoot?: string;
  }): Promise<string | null> {
    if (!block.evidence) return "no evidence";
    if (block.difficulty !== this.omega.difficulty) return "difficulty is not the next difficulty";
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
    const committed = await this.commit({
      transactions: block.transactions ?? [],
      evidence: block.evidence,
      timestamp: block.timestamp,
      nonce,
      miner: block.miner,
      committedPressure: block.committedPressure ?? 0,
      couplings: openedCouplings(before),
      difficulty: block.difficulty,
    });
    if (!committed.ok) return committed.error;
    if (committed.hash !== block.hash) {
      this.omega = before;
      this.blocks.pop();
      return "header is not the successor";
    }
    if (block.omegaRoot && block.omegaRoot !== committed.omegaRoot) {
      this.omega = before;
      this.blocks.pop();
      return "omega root does not replay";
    }
    if (block.stateRoot && block.stateRoot !== committed.stateRoot) {
      this.omega = before;
      this.blocks.pop();
      return "state root does not replay";
    }
    return null;
  }
}
