import { bytesToHex, concatBytes, hexToBytes, utf8 } from "./bytes";

/**
 * Ethereum execution proofs.
 * The block hash is keccak256 of the execution header RLP.
 * A receipt is in that header only when a secure Merkle-Patricia proof
 * reaches the receiptsRoot. An EQU beacon bodyRoot is not that root.
 * This does not verify Ethereum's sync committee.
 */

const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, n: number): bigint {
  if (n === 0) return x;
  const s = BigInt(n);
  return ((x << s) | (x >> (64n - s))) & MASK64;
}

function keccakF(a: bigint[][]): void {
  for (let round = 0; round < 24; round += 1) {
    const c = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x += 1) c[x] = a[x]![0]! ^ a[x]![1]! ^ a[x]![2]! ^ a[x]![3]! ^ a[x]![4]!;
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y += 1) a[x]![y] = (a[x]![y]! ^ d) & MASK64;
    }
    const b = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        b[y]![(2 * x + 3 * y) % 5] = rotl(a[x]![y]!, ROT[x]![y]!);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        a[x]![y] = (b[x]![y]! ^ ((~b[(x + 1) % 5]![y]! & MASK64) & b[(x + 2) % 5]![y]!)) & MASK64;
      }
    }
    a[0]![0] = (a[0]![0]! ^ RC[round]!) & MASK64;
  }
}

/** Keccak-256, not SHA3-256. Ethereum hashes with the 0x01 pad. */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136;
  const a = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);
  const absorb = (block: Uint8Array) => {
    for (let i = 0; i < block.length; i += 1) {
      const lane = i >> 3;
      const x = lane % 5;
      const y = Math.floor(lane / 5);
      a[x]![y] = (a[x]![y]! ^ (BigInt(block[i]!) << BigInt((i & 7) * 8))) & MASK64;
    }
    keccakF(a);
  };
  let offset = 0;
  while (offset + rate <= data.length) {
    absorb(data.subarray(offset, offset + rate));
    offset += rate;
  }
  const last = new Uint8Array(rate);
  last.set(data.subarray(offset));
  const rest = data.length - offset;
  last[rest] ^= 0x01;
  last[rate - 1] ^= 0x80;
  absorb(last);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const lane = i >> 3;
    const x = lane % 5;
    const y = Math.floor(lane / 5);
    out[i] = Number((a[x]![y]! >> BigInt((i & 7) * 8)) & 0xffn);
  }
  return out;
}

export function keccak256Hex(data: Uint8Array | string): string {
  return bytesToHex(keccak256(typeof data === "string" ? utf8(data) : data));
}

type Rlp = Uint8Array | Rlp[];

function minimalLen(length: number): Uint8Array {
  const out: number[] = [];
  let n = length;
  while (n > 0) {
    out.push(n & 0xff);
    n = Math.floor(n / 256);
  }
  out.reverse();
  return Uint8Array.from(out);
}

function rlpPrefix(offset: number, length: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const len = minimalLen(length);
  return concatBytes(Uint8Array.of(offset + 55 + len.length), len);
}

export function rlpEncodeBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0]! < 0x80) return bytes;
  return concatBytes(rlpPrefix(0x80, bytes.length), bytes);
}

export function rlpEncode(item: Rlp): Uint8Array {
  if (item instanceof Uint8Array) return rlpEncodeBytes(item);
  const payload = concatBytes(...item.map((child) => rlpEncode(child)));
  return concatBytes(rlpPrefix(0xc0, payload.length), payload);
}

export function rlpUintBytes(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) return new Uint8Array();
  if (n === 0) return new Uint8Array();
  const out: number[] = [];
  let x = n;
  while (x > 0) {
    out.push(x & 0xff);
    x = Math.floor(x / 256);
  }
  out.reverse();
  return Uint8Array.from(out);
}

export function rlpUint(n: number): Uint8Array {
  return rlpEncodeBytes(rlpUintBytes(n));
}

function readRlpUint(bytes: Uint8Array): number | null {
  if (bytes.length === 0) return 0;
  if (bytes[0] === 0) return null;
  if (bytes.length > 6) return null;
  let n = 0;
  for (const byte of bytes) {
    n = n * 256 + byte;
  }
  return Number.isSafeInteger(n) ? n : null;
}

function readAbiUint(bytes: Uint8Array): number | null {
  if (bytes.length !== 32) return null;
  let n = 0;
  for (const byte of bytes) {
    const next = n * 256 + byte;
    if (!Number.isSafeInteger(next)) return null;
    n = next;
  }
  return n;
}

function rlpDecodeAt(raw: Uint8Array, offset: number): { value: Rlp; next: number } | null {
  if (offset >= raw.length) return null;
  const first = raw[offset]!;
  if (first < 0x80) return { value: raw.subarray(offset, offset + 1), next: offset + 1 };
  if (first <= 0xb7) {
    const len = first - 0x80;
    const start = offset + 1;
    const end = start + len;
    if (end > raw.length) return null;
    if (len === 1 && raw[start]! < 0x80) return null;
    return { value: raw.subarray(start, end), next: end };
  }
  if (first <= 0xbf) {
    const lenOfLen = first - 0xb7;
    const start = offset + 1;
    if (start + lenOfLen > raw.length || lenOfLen === 0) return null;
    const lenBytes = raw.subarray(start, start + lenOfLen);
    if (lenBytes[0] === 0) return null;
    const len = readRlpUint(lenBytes);
    if (len === null || len < 56) return null;
    const dataStart = start + lenOfLen;
    const end = dataStart + len;
    if (end > raw.length) return null;
    return { value: raw.subarray(dataStart, end), next: end };
  }
  if (first <= 0xf7) {
    const len = first - 0xc0;
    const start = offset + 1;
    const end = start + len;
    if (end > raw.length) return null;
    const items = decodeList(raw.subarray(start, end));
    if (!items) return null;
    return { value: items, next: end };
  }
  const lenOfLen = first - 0xf7;
  const start = offset + 1;
  if (start + lenOfLen > raw.length || lenOfLen === 0) return null;
  const lenBytes = raw.subarray(start, start + lenOfLen);
  if (lenBytes[0] === 0) return null;
  const len = readRlpUint(lenBytes);
  if (len === null || len < 56) return null;
  const dataStart = start + lenOfLen;
  const end = dataStart + len;
  if (end > raw.length) return null;
  const items = decodeList(raw.subarray(dataStart, end));
  if (!items) return null;
  return { value: items, next: end };
}

function decodeList(raw: Uint8Array): Rlp[] | null {
  const items: Rlp[] = [];
  let i = 0;
  while (i < raw.length) {
    const next = rlpDecodeAt(raw, i);
    if (!next) return null;
    items.push(next.value);
    i = next.next;
  }
  return items;
}

export function rlpDecode(raw: Uint8Array): Rlp | null {
  const decoded = rlpDecodeAt(raw, 0);
  if (!decoded || decoded.next !== raw.length) return null;
  return decoded.value;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function toNibbles(bytes: Uint8Array): number[] {
  const out: number[] = [];
  for (const byte of bytes) out.push(byte >> 4, byte & 0x0f);
  return out;
}

function encodeHp(nibbles: number[], leaf: boolean): Uint8Array {
  const odd = nibbles.length % 2;
  const prefix = (leaf ? 0x20 : 0) | (odd ? 0x10 : 0);
  const out: number[] = [];
  let i = 0;
  if (odd) {
    out.push(prefix | nibbles[0]!);
    i = 1;
  } else out.push(prefix);
  for (; i < nibbles.length; i += 2) out.push((nibbles[i]! << 4) | nibbles[i + 1]!);
  return Uint8Array.from(out);
}

function decodeHp(path: Uint8Array): { leaf: boolean; nibbles: number[] } | null {
  if (!path.length) return null;
  const first = path[0]!;
  if ((first & 0xc0) !== 0) return null;
  const leaf = (first & 0x20) !== 0;
  const odd = (first & 0x10) !== 0;
  if (!odd && (first & 0x0f) !== 0) return null;
  const nibbles: number[] = [];
  if (odd) nibbles.push(first & 0x0f);
  for (let i = 1; i < path.length; i += 1) nibbles.push(path[i]! >> 4, path[i]! & 0x0f);
  return { leaf, nibbles };
}

function nibbleEq(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

/** Secure trie: the path is keccak256(key). A node under 32 bytes is stored inline. */
export function verifySecureTrie(root: Uint8Array, key: Uint8Array, proof: Uint8Array[]): Uint8Array | null {
  let nibbles = toNibbles(keccak256(key));
  let want = root;
  if (!proof.length) return null;
  for (let i = 0; i < proof.length; i += 1) {
    const node = proof[i]!;
    const inline = want.length < 32 && bytesEqual(want, node);
    const hashed = want.length === 32 && bytesEqual(keccak256(node), want);
    if (!inline && !hashed) return null;
    const decoded = rlpDecode(node);
    if (!Array.isArray(decoded)) return null;
    if (decoded.length === 17) {
      if (nibbles.length === 0) {
        const value = decoded[16];
        if (i !== proof.length - 1 || !(value instanceof Uint8Array)) return null;
        return value;
      }
      const next = decoded[nibbles[0]!];
      if (!(next instanceof Uint8Array)) return null;
      nibbles = nibbles.slice(1);
      want = next;
      continue;
    }
    if (decoded.length !== 2) return null;
    const path = decoded[0];
    const rest = decoded[1];
    if (!(path instanceof Uint8Array) || !(rest instanceof Uint8Array)) return null;
    const hp = decodeHp(path);
    if (!hp) return null;
    if (hp.leaf) {
      if (i !== proof.length - 1 || !nibbleEq(nibbles, hp.nibbles)) return null;
      return rest;
    }
    if (nibbles.length < hp.nibbles.length || !nibbleEq(nibbles.slice(0, hp.nibbles.length), hp.nibbles)) return null;
    nibbles = nibbles.slice(hp.nibbles.length);
    want = rest;
  }
  return null;
}

export function secureLeaf(key: Uint8Array, value: Uint8Array): { root: Uint8Array; proof: Uint8Array[] } {
  const node = rlpEncode([encodeHp(toNibbles(keccak256(key)), true), value]);
  const root = node.length < 32 ? node : keccak256(node);
  return { root, proof: [node] };
}

export const TRANSFER_TOPIC = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ParsedExecutionHeader {
  hash: string;
  parentHash: string;
  transactionsRoot: string;
  receiptsRoot: string;
  number: number;
}

export function parseExecutionHeader(raw: Uint8Array): ParsedExecutionHeader | null {
  const decoded = rlpDecode(raw);
  if (!Array.isArray(decoded) || decoded.length < 15) return null;
  if (!bytesEqual(rlpEncode(decoded), raw)) return null;
  const parent = decoded[0];
  const txRoot = decoded[4];
  const receiptRoot = decoded[5];
  const number = decoded[8];
  if (!(parent instanceof Uint8Array) || parent.length !== 32) return null;
  if (!(txRoot instanceof Uint8Array) || txRoot.length !== 32) return null;
  if (!(receiptRoot instanceof Uint8Array) || receiptRoot.length !== 32) return null;
  if (!(number instanceof Uint8Array)) return null;
  const height = readRlpUint(number);
  if (height === null) return null;
  return {
    hash: bytesToHex(keccak256(raw)),
    parentHash: bytesToHex(parent),
    transactionsRoot: bytesToHex(txRoot),
    receiptsRoot: bytesToHex(receiptRoot),
    number: height,
  };
}

interface ParsedLog {
  address: string;
  topics: string[];
  data: Uint8Array;
}

function parseReceipt(raw: Uint8Array): { status: number; logs: ParsedLog[] } | null {
  let body = raw;
  if (raw.length > 0 && raw[0]! < 0xc0) {
    if (raw[0]! < 1 || raw[0]! > 4) return null;
    body = raw.subarray(1);
  }
  const decoded = rlpDecode(body);
  if (!Array.isArray(decoded) || decoded.length < 4) return null;
  const statusBytes = decoded[0];
  const logs = decoded[3];
  if (!(statusBytes instanceof Uint8Array) || !Array.isArray(logs)) return null;
  const status = readRlpUint(statusBytes);
  if (status === null || (status !== 0 && status !== 1)) return null;
  const parsed: ParsedLog[] = [];
  for (const item of logs) {
    if (!Array.isArray(item) || item.length < 3) return null;
    const address = item[0];
    const topics = item[1];
    const data = item[2];
    if (!(address instanceof Uint8Array) || address.length !== 20) return null;
    if (!Array.isArray(topics) || !(data instanceof Uint8Array)) return null;
    const topicHex: string[] = [];
    for (const topic of topics) {
      if (!(topic instanceof Uint8Array) || topic.length !== 32) return null;
      topicHex.push(bytesToHex(topic));
    }
    parsed.push({ address: bytesToHex(address), topics: topicHex, data });
  }
  return { status, logs: parsed };
}

function parseNativeTx(raw: Uint8Array): { to: string; value: number } | null {
  let body = raw;
  let kind: "legacy" | "1" | "2" = "legacy";
  if (raw.length > 1 && raw[0]! < 0xc0) {
    if (raw[0] === 1) kind = "1";
    else if (raw[0] === 2) kind = "2";
    else return null;
    body = raw.subarray(1);
  }
  const decoded = rlpDecode(body);
  if (!Array.isArray(decoded)) return null;
  const toAt = kind === "legacy" ? 3 : kind === "1" ? 4 : 5;
  const valueAt = toAt + 1;
  const to = decoded[toAt];
  const value = decoded[valueAt];
  if (!(to instanceof Uint8Array) || to.length !== 20) return null;
  if (!(value instanceof Uint8Array)) return null;
  const amount = readRlpUint(value);
  if (amount === null) return null;
  return { to: bytesToHex(to), value: amount };
}

export interface EthEffect {
  blockHash: string;
  asset: string;
  destination: string;
  amount: number;
  locator: string;
}

export function decodeEvenHex(value: string): Uint8Array | null {
  const clean = value.trim().toLowerCase().replace(/^0x/, "");
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  return hexToBytes(clean);
}

function hexList(values: string[]): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  for (const value of values) {
    const clean = value.trim().toLowerCase().replace(/^0x/, "");
    if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
    out.push(hexToBytes(clean));
  }
  return out;
}

export function isEthDestination(destination: string): boolean {
  return /^eth:[0-9a-f]{40}$/.test(destination);
}

export function isEthAsset(asset: string): boolean {
  return asset === "eth" || /^[0-9a-f]{40}$/.test(asset);
}

/**
 * Derive the external effect from an execution header already stored in Ω.
 * Native ETH is the transaction's `to` and `value`, and the receipt must succeed.
 * Any other asset is the token address on a Transfer log.
 */
export function proveEthEffect(input: {
  receiptsRoot: string;
  transactionsRoot: string;
  blockHash: string;
  txIndex: number;
  receiptRlp: string;
  receiptProof: string[];
  logIndex: number;
  txRlp: string;
  txProof: string[];
  asset: string;
}): { ok: true; effect: EthEffect } | { ok: false; error: string } {
  if (!Number.isSafeInteger(input.txIndex) || input.txIndex < 0) return { ok: false, error: "eth receipt refused" };
  if (!/^[0-9a-f]{64}$/.test(input.receiptsRoot) || !/^[0-9a-f]{64}$/.test(input.transactionsRoot)) {
    return { ok: false, error: "eth header is not in Ω" };
  }
  const receipt = hexList([input.receiptRlp]);
  const receiptProof = hexList(input.receiptProof);
  if (!receipt || !receiptProof) return { ok: false, error: "eth receipt refused" };
  const key = rlpUint(input.txIndex);
  const proved = verifySecureTrie(hexToBytes(input.receiptsRoot), key, receiptProof);
  if (!proved || !bytesEqual(proved, receipt[0]!)) return { ok: false, error: "eth trie refused" };
  const parsed = parseReceipt(receipt[0]!);
  if (!parsed || parsed.status !== 1) return { ok: false, error: "eth receipt refused" };
  if (input.asset === "eth") {
    const txRaw = hexList([input.txRlp]);
    const txProof = hexList(input.txProof);
    if (!txRaw || !txProof || !txRaw[0]!.length) return { ok: false, error: "eth transaction refused" };
    const txValue = verifySecureTrie(hexToBytes(input.transactionsRoot), key, txProof);
    if (!txValue || !bytesEqual(txValue, txRaw[0]!)) return { ok: false, error: "eth trie refused" };
    const tx = parseNativeTx(txRaw[0]!);
    if (!tx) return { ok: false, error: "eth transaction refused" };
    return {
      ok: true,
      effect: {
        blockHash: input.blockHash,
        asset: "eth",
        destination: `eth:${tx.to}`,
        amount: tx.value,
        locator: `${input.blockHash}:${input.txIndex}:value`,
      },
    };
  }
  if (!/^[0-9a-f]{40}$/.test(input.asset)) return { ok: false, error: "withdrawal asset refused" };
  if (!Number.isSafeInteger(input.logIndex) || input.logIndex < 0 || input.logIndex >= parsed.logs.length) {
    return { ok: false, error: "eth log refused" };
  }
  const log = parsed.logs[input.logIndex]!;
  if (log.address !== input.asset || log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) {
    return { ok: false, error: "eth log refused" };
  }
  const toTopic = log.topics[2]!;
  if (!toTopic.startsWith("0".repeat(24))) return { ok: false, error: "eth log refused" };
  const amount = readAbiUint(log.data);
  if (amount === null) return { ok: false, error: "eth amount refused" };
  return {
    ok: true,
    effect: {
      blockHash: input.blockHash,
      asset: log.address,
      destination: `eth:${toTopic.slice(24)}`,
      amount,
      locator: `${input.blockHash}:${input.txIndex}:${input.logIndex}`,
    },
  };
}

export function legacyReceipt(input: {
  status: number;
  cumulativeGas: number;
  logs: Array<{ address: string; topics: string[]; data: Uint8Array }>;
}): Uint8Array {
  const logs = input.logs.map((log) => [
    hexToBytes(log.address),
    log.topics.map((topic) => hexToBytes(topic)),
    log.data,
  ]);
  return rlpEncode([
    rlpUintBytes(input.status),
    rlpUintBytes(input.cumulativeGas),
    new Uint8Array(256),
    logs,
  ]);
}

export function executionHeader(input: {
  parentHash: Uint8Array;
  transactionsRoot: Uint8Array;
  receiptsRoot: Uint8Array;
  number: number;
}): Uint8Array {
  const zero32 = new Uint8Array(32);
  return rlpEncode([
    input.parentHash,
    hexToBytes(keccak256Hex(Uint8Array.of(0xc0))),
    new Uint8Array(20),
    zero32,
    input.transactionsRoot,
    input.receiptsRoot,
    new Uint8Array(256),
    rlpUintBytes(0),
    rlpUintBytes(input.number),
    rlpUintBytes(21000),
    rlpUintBytes(21000),
    rlpUintBytes(1),
    new Uint8Array(),
    zero32,
    new Uint8Array(8),
  ]);
}
