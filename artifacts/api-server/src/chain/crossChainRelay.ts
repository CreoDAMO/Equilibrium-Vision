/**
 * CrossChainRelay TypeScript wrapper.
 *
 * Thin typed layer over the compiled `cross_chain_relay` WASM contract
 * (contracts/cross_chain_relay/src/lib.rs).  All crypto (signature
 * verification, address derivation) happens inside the contract — this module
 * only packs and unpacks the flat i32-word call ABI.
 *
 * Arg encoding rules (match the Rust contract's read_* helpers exactly):
 *  - Bytes / ASCII strings: 4 bytes per i32 word, little-endian packed.
 *    `stringToWords("abc", 8)` → 1 word containing [97,98,99,0].
 *  - u64 seq: two i32 words [lo, hi].
 *  - 32-byte hash: 8 words   (hexToWords32)
 *  - 64-byte sig:  16 words  (hexToWordsN(hex, 64))
 *  - 40-char addr: 10 words  (stringToWords(addr, 40))
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { WasmVM } from "./wasm.js";
import { logger } from "../lib/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveContractArtifact(...segments: string[]): string {
  const candidates = [
    join(__dirname, "..", "..", "..", "contracts", ...segments),
    join(__dirname, "..", "..", "..", "..", "contracts", ...segments),
    resolve(process.cwd(), "..", "..", "contracts", ...segments),
    resolve(process.cwd(), "contracts", ...segments),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

// ── encoding helpers (same patterns as modelRegistry.ts) ────────────────────

/** Encode a u64 as two i32 words [lo, hi]. */
function i64ToWords(value: bigint): [number, number] {
  const masked = BigInt.asUintN(64, value);
  const lo = Number(masked & 0xffffffffn);
  let hi = Number((masked >> 32n) & 0xffffffffn);
  if (hi > 0x7fffffff) hi -= 0x100000000;
  return [lo | 0, hi];
}

/** Pack a UTF-8 string into i32 words (4 bytes per word, little-endian). */
function stringToWords(str: string, maxBytes: number): number[] {
  const bytes = new TextEncoder().encode(str);
  if (bytes.length > maxBytes) throw new Error(`String too long: ${bytes.length} > ${maxBytes}`);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

/** Pack `byteLen` raw bytes from a hex string into i32 words (4 bytes each). */
function hexToWordsN(hex: string, byteLen: number): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== byteLen * 2) throw new Error(`Expected ${byteLen * 2} hex chars, got ${clean.length}`);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    let w = 0;
    for (let b = 0; b < 4; b++) w |= (bytes[i + b] ?? 0) << (b * 8);
    words.push(w);
  }
  return words;
}

/** Pack a 32-byte hash (64 hex chars) into 8 i32 words. */
function hexToWords32(hex: string): number[] {
  return hexToWordsN(hex, 32);
}

/** Encode a chain_id string + u64 seq into args prefix words. */
function chainSeqWords(chainId: string, seq: bigint): number[] {
  const idBytes = new TextEncoder().encode(chainId);
  if (idBytes.length === 0 || idBytes.length > 64) throw new Error("chain_id must be 1–64 bytes");
  const [seqLo, seqHi] = i64ToWords(seq);
  return [idBytes.length, ...stringToWords(chainId, 64), seqLo, seqHi];
}

/** Encode just a chain_id string into args prefix words. */
function chainWords(chainId: string): number[] {
  const idBytes = new TextEncoder().encode(chainId);
  if (idBytes.length === 0 || idBytes.length > 64) throw new Error("chain_id must be 1–64 bytes");
  return [idBytes.length, ...stringToWords(chainId, 64)];
}

// ── contract state ───────────────────────────────────────────────────────────

const METHOD = {
  REGISTER_RELAYER: 0,
  REVOKE_RELAYER: 1,
  SET_THRESHOLD: 2,
  SUBMIT_INBOUND: 3,
  CHALLENGE_INBOUND: 4,
  FINALIZE_INBOUND: 5,
  PUBLISH_OUTBOUND: 6,
  GET_INBOUND_STATUS: 7,
  GET_OUTBOUND_SEQ: 8,
  GET_THRESHOLD: 9,
  GET_RELAYER_COUNT: 10,
  SUBMIT_HEADER: 11,
  SUBMIT_INBOUND_SPV: 12,
} as const;

let cachedAddress: string | undefined;

export function getCrossChainRelayAddress(): string | undefined {
  return process.env["CROSS_CHAIN_RELAY_ADDRESS"] || cachedAddress;
}

function loadHex(): string {
  const p = resolveContractArtifact("cross_chain_relay", "cross_chain_relay.hex");
  return readFileSync(p, "utf-8").trim();
}

export async function deployCrossChainRelayIfNeeded(
  wasmVM: WasmVM,
  deployer: string,
): Promise<string | undefined> {
  const existing = getCrossChainRelayAddress();
  if (existing) {
    logger.info({ address: existing }, "CrossChainRelay configured via env — using existing contract");
    return existing;
  }
  let bytecodeHex: string;
  try {
    bytecodeHex = loadHex();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "CrossChainRelay hex not found — skipping deploy (run contracts/cross_chain_relay/build.sh first)");
    return undefined;
  }
  const { address, error } = await wasmVM.deploy(deployer, bytecodeHex, {
    functions: [
      { name: "registerRelayer",            methodId: METHOD.REGISTER_RELAYER,  inputs: ["i64"], outputs: ["i32"] },
      { name: "revokeRelayer",              methodId: METHOD.REVOKE_RELAYER,    inputs: [],      outputs: ["i32"] },
      { name: "setThreshold",               methodId: METHOD.SET_THRESHOLD,     inputs: ["i32"], outputs: ["i32"] },
      { name: "submitInboundAttestation",   methodId: METHOD.SUBMIT_INBOUND,    inputs: [],      outputs: ["i32"] },
      { name: "challengeInbound",           methodId: METHOD.CHALLENGE_INBOUND, inputs: [],      outputs: ["i32"] },
      { name: "finalizeInbound",            methodId: METHOD.FINALIZE_INBOUND,  inputs: [],      outputs: ["i32"] },
      { name: "publishOutbound",            methodId: METHOD.PUBLISH_OUTBOUND,  inputs: [],      outputs: ["i32"] },
      { name: "getInboundStatus",           methodId: METHOD.GET_INBOUND_STATUS, inputs: [],     outputs: ["i32"] },
      { name: "getOutboundSeq",             methodId: METHOD.GET_OUTBOUND_SEQ,  inputs: [],      outputs: ["i32"] },
      { name: "getThreshold",               methodId: METHOD.GET_THRESHOLD,     inputs: [],      outputs: ["i32"] },
      { name: "getRelayerCount",            methodId: METHOD.GET_RELAYER_COUNT, inputs: [],      outputs: ["i32"] },
    ],
  });
  if (error || !address) {
    logger.error({ error }, "Failed to deploy CrossChainRelay contract");
    return undefined;
  }
  cachedAddress = address;
  logger.info(
    { address },
    "CrossChainRelay deployed — set CROSS_CHAIN_RELAY_ADDRESS to this value to keep it stable across restarts",
  );
  return address;
}

// ── typed public API ─────────────────────────────────────────────────────────

export interface RegisterRelayerResult { success: boolean; error?: string }

/** Caller bonds `amount` EQU into the contract to join the relayer set. */
export async function registerRelayer(
  wasmVM: WasmVM,
  caller: string,
  amount: bigint,
): Promise<RegisterRelayerResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  const [lo, hi] = i64ToWords(amount);
  const res = await wasmVM.call(address, METHOD.REGISTER_RELAYER, [lo, hi], undefined, caller);
  if (!res.success || res.returnValue === null || res.returnValue < 0) {
    const msgs: Record<number, string> = {
      0: "Amount below minimum bond",
      [-1]: "Address already in relayer set",
      [-2]: "Bond failed (insufficient balance or no caller)",
    };
    return { success: false, error: res.error ?? msgs[res.returnValue ?? -2] ?? `register_relayer() → ${res.returnValue}` };
  }
  return { success: true };
}

export interface RevokeRelayerResult { success: boolean; error?: string }

/** Admin: remove a relayer and return their bond. */
export async function revokeRelayer(
  wasmVM: WasmVM,
  caller: string,
  relayerAddress: string,
): Promise<RevokeRelayerResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  if (!/^[0-9a-f]{40}$/.test(relayerAddress)) return { success: false, error: "Invalid relayerAddress" };
  const args = stringToWords(relayerAddress, 40);
  const res = await wasmVM.call(address, METHOD.REVOKE_RELAYER, args, undefined, caller);
  if (!res.success || !res.returnValue) return { success: false, error: res.error ?? "relayer not found" };
  return { success: true };
}

export interface SetThresholdResult { success: boolean; error?: string }

/** Admin: update the m-of-n signature threshold. */
export async function setThreshold(
  wasmVM: WasmVM,
  caller: string,
  m: number,
): Promise<SetThresholdResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  const res = await wasmVM.call(address, METHOD.SET_THRESHOLD, [m], undefined, caller);
  if (!res.success || !res.returnValue) return { success: false, error: res.error ?? "invalid threshold" };
  return { success: true };
}

export interface BLSSigner {
  /** 96 hex chars — BLS12-381 G1 compressed public key (48 bytes) */
  pubkeyHex: string;
  /** 40 hex chars — relayer address on Equilibrium */
  signerAddress: string;
}

export interface SubmitInboundParams {
  chainId: string;
  seq: bigint;
  /** 64 hex chars (32 bytes) — the foreign-chain state commitment */
  commitmentHex: string;
  /** 192 hex chars — BLS12-381 G2 compressed aggregate signature (96 bytes).
   *  Produced by aggregating one signature per signer over the canonical
   *  message `attest:{chainId}:{seq}:{commitmentHex}` (hashed to G2 via
   *  hashToCurve before signing, matching the bls_verify host implementation). */
  aggSigHex: string;
  /** One entry per signing relayer; must meet or exceed the threshold. */
  signers: BLSSigner[];
}

export interface SubmitInboundResult {
  success: boolean;
  error?: string;
}

export async function submitInboundAttestation(
  wasmVM: WasmVM,
  caller: string,
  p: SubmitInboundParams,
): Promise<SubmitInboundResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  if (!p.signers.length) return { success: false, error: "At least one signer required" };
  if (!/^[0-9a-f]{64}$/.test(p.commitmentHex)) return { success: false, error: "commitmentHex must be 64 hex chars (32 bytes)" };
  if (!/^[0-9a-f]{192}$/.test(p.aggSigHex)) return { success: false, error: "aggSigHex must be 192 hex chars (96-byte BLS G2 signature)" };

  let args: number[];
  try {
    const [seqLo, seqHi] = i64ToWords(p.seq);
    const idBytes = new TextEncoder().encode(p.chainId);
    args = [
      idBytes.length,
      ...stringToWords(p.chainId, 64),  // chain_id words (up to 16 words)
      seqLo, seqHi,
      ...hexToWords32(p.commitmentHex), //  8 words — commitment
      p.signers.length,                 //  n_signers
      ...hexToWordsN(p.aggSigHex, 96),  // 24 words — BLS G2 aggregate signature
    ];
    for (const s of p.signers) {
      if (!/^[0-9a-f]{96}$/.test(s.pubkeyHex)) throw new Error(`pubkeyHex must be 96 hex chars (48-byte BLS G1 pubkey): got ${s.pubkeyHex.slice(0, 8)}…`);
      if (!/^[0-9a-f]{40}$/.test(s.signerAddress)) throw new Error(`signerAddress must be 40 hex chars: got ${s.signerAddress}`);
      args.push(...hexToWordsN(s.pubkeyHex, 48));       // 12 words — BLS G1 pubkey
      args.push(...stringToWords(s.signerAddress, 40)); // 10 words — address
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  if (args.length > 1024) {
    return { success: false, error: `Too many signers: ${args.length} words exceeds 1024-word limit` };
  }

  const res = await wasmVM.call(address, METHOD.SUBMIT_INBOUND, args, undefined, caller);
  if (!res.success || res.returnValue !== 1) {
    const msgs: Record<number, string> = {
      [-1]: "Empty or invalid chain_id",
      [-2]: "Signature verification failed",
      [-3]: "No signatures provided",
      [-4]: "Bad sequence number (expected next sequential value)",
      [-5]: "Attestation already exists for this chain+seq",
      [-6]: "No relayers registered",
      [-7]: "Signer is not a registered relayer",
      [-8]: "Duplicate signer in this attestation",
      [-9]: "Threshold not met (too few valid signatures)",
    };
    return {
      success: false,
      error: res.error ?? msgs[res.returnValue ?? -1] ?? `submit_inbound() → ${res.returnValue}`,
    };
  }
  return { success: true };
}

export interface ChallengeResult { success: boolean; error?: string }

/** Admin: flag an attestation as fraudulent and slash the signers. */
export async function challengeInbound(
  wasmVM: WasmVM,
  caller: string,
  chainId: string,
  seq: bigint,
): Promise<ChallengeResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  let args: number[];
  try {
    args = chainSeqWords(chainId, seq);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
  const res = await wasmVM.call(address, METHOD.CHALLENGE_INBOUND, args, undefined, caller);
  if (!res.success || res.returnValue !== 1) {
    const msgs: Record<number, string> = {
      [-1]: "Attestation not found",
      [-2]: "Already finalized",
      [-3]: "Already challenged",
    };
    return { success: false, error: res.error ?? msgs[res.returnValue ?? -1] ?? `challenge() → ${res.returnValue}` };
  }
  return { success: true };
}

export interface FinalizeResult { success: boolean; error?: string }

/** Anyone can finalize an unchallenged attestation after the challenge window. */
export async function finalizeInbound(
  wasmVM: WasmVM,
  caller: string,
  chainId: string,
  seq: bigint,
): Promise<FinalizeResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  let args: number[];
  try {
    args = chainSeqWords(chainId, seq);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
  const res = await wasmVM.call(address, METHOD.FINALIZE_INBOUND, args, undefined, caller);
  if (!res.success || res.returnValue !== 1) {
    const msgs: Record<number, string> = {
      [-1]: "Attestation not found",
      [-2]: "Already finalized",
      [-3]: "Challenge window still open",
      [-4]: "Attestation was challenged — cannot finalize",
    };
    return { success: false, error: res.error ?? msgs[res.returnValue ?? -1] ?? `finalize() → ${res.returnValue}` };
  }
  return { success: true };
}

export interface PublishOutboundResult {
  success: boolean;
  outboundSeq?: number;
  error?: string;
}

/** Record a local state commitment for external chains to verify. */
export async function publishOutbound(
  wasmVM: WasmVM,
  caller: string,
  chainId: string,
  commitmentHex: string,
): Promise<PublishOutboundResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  if (!/^[0-9a-f]{64}$/.test(commitmentHex)) {
    return { success: false, error: "commitmentHex must be 64 hex chars" };
  }
  let args: number[];
  try {
    args = [...chainWords(chainId), ...hexToWords32(commitmentHex)];
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
  const res = await wasmVM.call(address, METHOD.PUBLISH_OUTBOUND, args, undefined, caller);
  if (!res.success || !res.returnValue || res.returnValue <= 0) {
    return { success: false, error: res.error ?? "publish failed" };
  }
  return { success: true, outboundSeq: res.returnValue };
}

export type InboundStatus = "pending" | "finalized" | "challenged" | "not_found";

export async function getInboundStatus(
  wasmVM: WasmVM,
  chainId: string,
  seq: bigint,
): Promise<InboundStatus> {
  const address = getCrossChainRelayAddress();
  if (!address) return "not_found";
  let args: number[];
  try {
    args = chainSeqWords(chainId, seq);
  } catch {
    return "not_found";
  }
  const res = await wasmVM.call(address, METHOD.GET_INBOUND_STATUS, args);
  if (!res.success || res.returnValue === null) return "not_found";
  return res.returnValue === 0 ? "pending"
    : res.returnValue === 1 ? "finalized"
    : res.returnValue === 2 ? "challenged"
    : "not_found";
}

export async function getOutboundSeq(wasmVM: WasmVM, chainId: string): Promise<number> {
  const address = getCrossChainRelayAddress();
  if (!address) return 0;
  let args: number[];
  try {
    args = chainWords(chainId);
  } catch {
    return 0;
  }
  const res = await wasmVM.call(address, METHOD.GET_OUTBOUND_SEQ, args);
  return res.success && res.returnValue !== null ? res.returnValue : 0;
}

export async function getRelayThreshold(wasmVM: WasmVM): Promise<number> {
  const address = getCrossChainRelayAddress();
  if (!address) return 2;
  const res = await wasmVM.call(address, METHOD.GET_THRESHOLD, []);
  return res.success && res.returnValue !== null ? res.returnValue : 2;
}

export async function getRelayerCount(wasmVM: WasmVM): Promise<number> {
  const address = getCrossChainRelayAddress();
  if (!address) return 0;
  const res = await wasmVM.call(address, METHOD.GET_RELAYER_COUNT, []);
  return res.success && res.returnValue !== null ? res.returnValue : 0;
}

/** Read relay contract storage directly for detailed inspection. */
export function getRelayDetails(wasmVM: WasmVM): {
  relayers: string[];
  threshold: number;
  storage: Record<string, string>;
} {
  const address = getCrossChainRelayAddress();
  if (!address) return { relayers: [], threshold: 2, storage: {} };
  const storage = wasmVM.getStorage(address);
  const relayerSet = storage["relay:set"] ?? "";
  const relayers = relayerSet.split(",").filter(Boolean);
  const threshold = parseInt(storage["relay:threshold"] ?? "2", 10) || 2;
  return { relayers, threshold, storage };
}

/** Build the canonical message that relayers sign for an inbound attestation. */
export function buildAttestationMessage(chainId: string, seq: bigint, commitmentHex: string): string {
  return `attest:${chainId}:${seq}:${commitmentHex}`;
}

// ── SPV header + Merkle inclusion proof ──────────────────────────────────────

export interface ForeignHeader {
  chainId: string;
  /** Foreign-chain block number being anchored */
  blockNum: bigint;
  /** 64 hex chars (32 bytes) — SHA-256 binary Merkle root of the foreign block */
  merkleRootHex: string;
}

export interface SubmitHeaderResult {
  success: boolean;
  error?: string;
  chainId?: string;
  blockNum?: string;
}

export interface MerkleProof {
  /**
   * Leaf position in the bottom layer of the Merkle tree.
   * Combined with the sibling hashes this uniquely identifies the path.
   */
  leafIndex: bigint;
  /**
   * Sibling hashes from leaf level up to (but not including) the root,
   * each 64 hex chars (32 bytes). Empty array = single-leaf tree.
   */
  siblings: string[];
}

export interface SubmitInboundSpvParams extends SubmitInboundParams {
  /** Which foreign block's header to verify inclusion against */
  spvBlockNum: bigint;
  /** Merkle inclusion proof that `commitmentHex` is in that block's Merkle root */
  proof: MerkleProof;
}

/**
 * Submit a foreign-chain block header (just its Merkle root) for SPV anchoring.
 * Caller must be a registered relayer.
 *
 * ABI — method 11:
 *   chain_id_len, chain_id_words, block_num_lo, block_num_hi, merkle_root[8 words]
 */
export async function submitForeignHeader(
  wasmVM: WasmVM,
  caller: string,
  p: ForeignHeader,
): Promise<SubmitHeaderResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  if (!/^[0-9a-f]{64}$/.test(p.merkleRootHex)) {
    return { success: false, error: "merkleRootHex must be 64 hex chars (32 bytes)" };
  }
  let args: number[];
  try {
    const [blockLo, blockHi] = i64ToWords(p.blockNum);
    const idBytes = new TextEncoder().encode(p.chainId);
    args = [
      idBytes.length,
      ...stringToWords(p.chainId, 64),
      blockLo, blockHi,
      ...hexToWords32(p.merkleRootHex),   // 8 words — 32-byte Merkle root
    ];
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
  const res = await wasmVM.call(address, METHOD.SUBMIT_HEADER, args, undefined, caller);
  if (!res.success || res.returnValue !== 1) {
    const msgs: Record<number, string> = {
      [-1]: "Empty or invalid chain_id",
      [-6]: "No relayers registered",
      [-7]: "Caller is not a registered relayer",
    };
    return {
      success: false,
      error: res.error ?? msgs[res.returnValue ?? -1] ?? `submit_header() → ${res.returnValue}`,
    };
  }
  return { success: true, chainId: p.chainId, blockNum: p.blockNum.toString() };
}

/**
 * Submit a BLS-attested inbound event WITH a Merkle inclusion proof.
 * The commitment must be provably included in a previously submitted header.
 *
 * Leaf hash: SHA-256 of the commitmentHex string (UTF-8 bytes), matching the
 * Rust `sha256_bytes(commitment_hex.as_bytes())` in `verify_merkle_proof`.
 *
 * ABI — method 12 (same prefix as method 3, then SPV section):
 *   [method 3 ABI] + block_num_lo, block_num_hi, proof_depth,
 *                    leaf_index_lo, leaf_index_hi,
 *                    [sibling: 8 words] × proof_depth
 */
export async function submitInboundAttestationSpv(
  wasmVM: WasmVM,
  caller: string,
  p: SubmitInboundSpvParams,
): Promise<SubmitInboundResult> {
  const address = getCrossChainRelayAddress();
  if (!address) return { success: false, error: "CrossChainRelay not configured" };
  if (!p.signers.length) return { success: false, error: "At least one signer required" };
  if (!/^[0-9a-f]{64}$/.test(p.commitmentHex)) return { success: false, error: "commitmentHex must be 64 hex chars (32 bytes)" };
  if (!/^[0-9a-f]{192}$/.test(p.aggSigHex)) return { success: false, error: "aggSigHex must be 192 hex chars (96-byte BLS G2 signature)" };
  for (const sib of p.proof.siblings) {
    if (!/^[0-9a-f]{64}$/.test(sib)) return { success: false, error: "Each Merkle sibling must be 64 hex chars (32 bytes)" };
  }

  let args: number[];
  try {
    const [seqLo, seqHi] = i64ToWords(p.seq);
    const idBytes = new TextEncoder().encode(p.chainId);
    args = [
      idBytes.length,
      ...stringToWords(p.chainId, 64),
      seqLo, seqHi,
      ...hexToWords32(p.commitmentHex),
      p.signers.length,
      ...hexToWordsN(p.aggSigHex, 96),
    ];
    for (const s of p.signers) {
      if (!/^[0-9a-f]{96}$/.test(s.pubkeyHex)) throw new Error(`pubkeyHex must be 96 hex chars: got ${s.pubkeyHex.slice(0, 8)}…`);
      if (!/^[0-9a-f]{40}$/.test(s.signerAddress)) throw new Error(`signerAddress must be 40 hex chars: got ${s.signerAddress}`);
      args.push(...hexToWordsN(s.pubkeyHex, 48));
      args.push(...stringToWords(s.signerAddress, 40));
    }
    // SPV section
    const [blockLo, blockHi] = i64ToWords(p.spvBlockNum);
    const [leafLo, leafHi]   = i64ToWords(p.proof.leafIndex);
    args.push(blockLo, blockHi);
    args.push(p.proof.siblings.length);
    args.push(leafLo, leafHi);
    for (const sib of p.proof.siblings) {
      args.push(...hexToWords32(sib));  // 8 words per sibling
    }
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  if (args.length > 1024) {
    return { success: false, error: `Proof too large: ${args.length} words exceeds 1024-word limit` };
  }

  const res = await wasmVM.call(address, METHOD.SUBMIT_INBOUND_SPV, args, undefined, caller);
  if (!res.success || res.returnValue !== 1) {
    const msgs: Record<number, string> = {
      [-1]: "Empty or invalid chain_id",
      [-2]: "Signature verification failed",
      [-3]: "No signatures provided",
      [-4]: "Bad sequence number (expected next sequential value)",
      [-5]: "Attestation already exists for this chain+seq",
      [-6]: "No relayers registered",
      [-7]: "Signer is not a registered relayer",
      [-8]: "Duplicate signer in this attestation",
      [-9]: "Threshold not met (too few valid signatures)",
      [-10]: "No header submitted for that block number on this chain",
      [-11]: "Merkle inclusion proof is invalid",
    };
    return {
      success: false,
      error: res.error ?? msgs[res.returnValue ?? -1] ?? `submit_inbound_spv() → ${res.returnValue}`,
    };
  }
  return { success: true };
}
