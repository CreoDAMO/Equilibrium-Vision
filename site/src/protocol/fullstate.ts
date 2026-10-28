/**
 * FS1 — exact bytes of one Ω.
 *
 * applySuccessor records fullStateId at the stateRoot line. That string is the
 * checkpoint identity. It is not what commit or absorb compare, and it is not
 * the header. omegaDigest remains the digest those paths compare.
 *
 * The bytes are the U2 representation: every declared field, in the order
 * Omega declares it, with map insertion order and IEEE-754 bits kept.
 * Empty is a counted collection. Absent is a different tag. A delimiter
 * never ends a field.
 */
import { sha256Hex } from "./crypto";
import type { Omega } from "./constitution";
import type {
  AccountState,
  BtcHeaderRecord,
  Couplings,
  Delegation,
  DexPool,
  EthExecutionHeader,
  EthHeaderRecord,
  ModelClaim,
  Proposal,
  Settlement,
  Unbonding,
  ValidatorRecord,
  Withdrawal,
} from "./types";

export const FULL_STATE_VERSION = 1;

const text = new TextEncoder();
const utf8 = new TextDecoder();

/** Value tags. A decoder rejects a tag it does not know. */
const T = {
  f64: 1,
  str: 2,
  bool: 3,
  null: 4,
  absent: 5,
  list: 6,
  map: 7,
  rec: 9,
} as const;

/**
 * Record type ids. Field counts are part of the bytes.
 * 0 is Ω, in declaration order, finalizedHeight last.
 */
const R = {
  omega: 0,
  couplings: 1,
  account: 2,
  pool: 3,
  btc: 4,
  eth: 5,
  validator: 6,
  delegation: 7,
  unbonding: 8,
  withdrawal: 9,
  execution: 10,
  proposal: 11,
  ballot: 12,
  model: 13,
  settlement: 14,
} as const;

class Buf {
  private parts: Uint8Array[] = [];
  u8(n: number) {
    this.parts.push(Uint8Array.of(n & 0xff));
  }
  u32(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("FS1 length is not a u32");
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    this.parts.push(b);
  }
  f64(n: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, n, true);
    this.parts.push(b);
  }
  raw(b: Uint8Array) {
    this.parts.push(b);
  }
  finish(): Uint8Array {
    let len = 0;
    for (const p of this.parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

class Reader {
  private o = 0;
  constructor(private readonly b: Uint8Array) {}
  private need(n: number) {
    if (this.o + n > this.b.length) throw new Error("FS1 truncated");
  }
  u8(): number {
    this.need(1);
    return this.b[this.o++]!;
  }
  u32(): number {
    this.need(4);
    const n = new DataView(this.b.buffer, this.b.byteOffset + this.o, 4).getUint32(0, true);
    this.o += 4;
    return n;
  }
  f64(): number {
    this.need(8);
    const n = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getFloat64(0, true);
    this.o += 8;
    return n;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  done() {
    if (this.o !== this.b.length) throw new Error("FS1 trailing bytes");
  }
}

function num(buf: Buf, n: number) {
  if (typeof n !== "number") throw new Error("FS1 number is not a number");
  buf.u8(T.f64);
  buf.f64(n);
}

function str(buf: Buf, s: string) {
  if (typeof s !== "string") throw new Error("FS1 string is not a string");
  const raw = text.encode(s);
  buf.u8(T.str);
  buf.u32(raw.length);
  buf.raw(raw);
}

function bool(buf: Buf, v: boolean) {
  if (typeof v !== "boolean") throw new Error("FS1 boolean is not a boolean");
  buf.u8(T.bool);
  buf.u8(v ? 1 : 0);
}

function hole(buf: Buf, v: unknown, enc: (present: unknown) => void) {
  if (v === undefined) {
    buf.u8(T.absent);
    return;
  }
  if (v === null) {
    buf.u8(T.null);
    return;
  }
  enc(v);
}

function list<T>(buf: Buf, items: readonly T[], enc: (item: T) => void) {
  buf.u8(T.list);
  buf.u32(items.length);
  for (const item of items) enc(item);
}

function mapOf<V>(buf: Buf, entries: Iterable<[string, V]>, enc: (value: V) => void) {
  const rows = [...entries];
  buf.u8(T.map);
  buf.u32(rows.length);
  for (const [key, value] of rows) {
    str(buf, key);
    enc(value);
  }
}

function rec(buf: Buf, typeId: number, fields: number, body: () => void) {
  buf.u8(T.rec);
  buf.u8(typeId);
  buf.u8(fields);
  body();
}

function couplings(buf: Buf, c: Couplings) {
  rec(buf, R.couplings, 5, () => {
    num(buf, c.hash);
    num(buf, c.structural);
    num(buf, c.continuity);
    num(buf, c.mempool);
    num(buf, c.fees);
  });
}

function account(buf: Buf, a: AccountState) {
  rec(buf, R.account, 2, () => {
    num(buf, a.balance);
    num(buf, a.nonce);
  });
}

function pool(buf: Buf, p: DexPool) {
  rec(buf, R.pool, 8, () => {
    str(buf, p.id);
    str(buf, p.tokenA);
    str(buf, p.tokenB);
    num(buf, p.reserveA);
    num(buf, p.reserveB);
    num(buf, p.fee);
    num(buf, p.txCount);
    str(buf, p.address);
  });
}

function btc(buf: Buf, h: BtcHeaderRecord) {
  rec(buf, R.btc, 5, () => {
    str(buf, h.hash);
    num(buf, h.height);
    str(buf, h.prevHash);
    str(buf, h.merkleRoot);
    num(buf, h.bits);
  });
}

function eth(buf: Buf, h: EthHeaderRecord) {
  rec(buf, R.eth, 7, () => {
    num(buf, h.slot);
    str(buf, h.hash);
    str(buf, h.parentRoot);
    str(buf, h.stateRoot);
    str(buf, h.bodyRoot);
    num(buf, h.participants);
    str(buf, h.participation);
  });
}

function validator(buf: Buf, v: ValidatorRecord) {
  rec(buf, R.validator, 9, () => {
    str(buf, v.address);
    str(buf, v.moniker);
    num(buf, v.bondedStake);
    num(buf, v.accumulatedRewards);
    bool(buf, v.slashed);
    bool(buf, v.jailed);
    num(buf, v.uptime);
    num(buf, v.blocksProposed);
    num(buf, v.commission);
  });
}

function delegation(buf: Buf, d: Delegation) {
  rec(buf, R.delegation, 3, () => {
    str(buf, d.delegator);
    str(buf, d.validator);
    num(buf, d.amount);
  });
}

function unbonding(buf: Buf, u: Unbonding) {
  rec(buf, R.unbonding, 4, () => {
    str(buf, u.delegator);
    str(buf, u.validator);
    num(buf, u.amount);
    num(buf, u.matureAt);
  });
}

function withdrawal(buf: Buf, w: Withdrawal) {
  rec(buf, R.withdrawal, 11, () => {
    str(buf, w.id);
    str(buf, w.sender);
    num(buf, w.amount);
    str(buf, w.network);
    str(buf, w.asset);
    str(buf, w.destination);
    num(buf, w.nonce);
    num(buf, w.createdHeight);
    num(buf, w.expiryHeight);
    str(buf, w.status);
    hole(buf, w.effectLocator, (locator) => str(buf, locator as string));
  });
}

function execution(buf: Buf, h: EthExecutionHeader) {
  rec(buf, R.execution, 5, () => {
    str(buf, h.hash);
    str(buf, h.parentHash);
    str(buf, h.receiptsRoot);
    str(buf, h.transactionsRoot);
    num(buf, h.number);
  });
}

function proposal(buf: Buf, p: Proposal) {
  rec(buf, R.proposal, 11, () => {
    num(buf, p.id);
    str(buf, p.title);
    str(buf, p.proposer);
    num(buf, p.deposit);
    num(buf, p.yes);
    num(buf, p.no);
    num(buf, p.abstain);
    str(buf, p.status);
    hole(buf, p.ballots, (ballots) => {
      list(buf, ballots as NonNullable<Proposal["ballots"]>, (b) => {
        rec(buf, R.ballot, 2, () => {
          str(buf, b.voter);
          str(buf, b.option);
        });
      });
    });
    hole(buf, p.couplingKey, (key) => str(buf, key as string));
    hole(buf, p.couplingValue, (value) => num(buf, value as number));
  });
}

function model(buf: Buf, m: ModelClaim) {
  rec(buf, R.model, 6, () => {
    num(buf, m.id);
    str(buf, m.uri);
    num(buf, m.residualFp);
    str(buf, m.supportHash);
    str(buf, m.status);
    num(buf, m.proposedAt);
  });
}

function settlement(buf: Buf, s: Settlement) {
  rec(buf, R.settlement, 7, () => {
    num(buf, s.id);
    str(buf, s.asset);
    str(buf, s.foreignRef);
    str(buf, s.from);
    str(buf, s.to);
    num(buf, s.amount);
    str(buf, s.status);
  });
}

/** Exact FS1 bytes of this object, including holes the digest collapses. */
export function encodeOmega(omega: Omega): Uint8Array {
  const buf = new Buf();
  buf.raw(text.encode("EQFS"));
  buf.u8(FULL_STATE_VERSION);
  const ethCommittee = (omega as { ethCommittee?: string | null }).ethCommittee;
  const ethExecution = (omega as { ethExecution?: EthExecutionHeader[] | null }).ethExecution;
  rec(buf, R.omega, 22, () => {
    num(buf, omega.chainId);
    num(buf, omega.height);
    str(buf, omega.tipHash);
    num(buf, omega.tipTimestamp);
    num(buf, omega.difficulty);
    couplings(buf, omega.couplings);
    mapOf(buf, omega.ledger, (row) => account(buf, row));
    list(buf, omega.pools, (row) => pool(buf, row));
    list(buf, omega.btc, (row) => btc(buf, row));
    str(buf, omega.ethPubkey);
    hole(buf, ethCommittee, (value) => str(buf, value as string));
    list(buf, omega.eth, (row) => eth(buf, row));
    mapOf(buf, omega.wasm, (value) => str(buf, value));
    mapOf(buf, omega.validators, (row) => validator(buf, row));
    list(buf, omega.delegations, (row) => delegation(buf, row));
    list(buf, omega.unbonding, (row) => unbonding(buf, row));
    list(buf, omega.withdrawals, (row) => withdrawal(buf, row));
    hole(buf, ethExecution, (rows) => list(buf, rows as EthExecutionHeader[], (row) => execution(buf, row)));
    list(buf, omega.proposals, (row) => proposal(buf, row));
    list(buf, omega.models, (row) => model(buf, row));
    list(buf, omega.settlements, (row) => settlement(buf, row));
    num(buf, omega.finalizedHeight);
  });
  return buf.finish();
}

/** sha256 of the FS1 bytes. Not omegaDigest, and not written into a header. */
export function fullStateId(omega: Omega): string {
  return sha256Hex(encodeOmega(omega));
}

function expect(r: Reader, tag: number) {
  const got = r.u8();
  if (got !== tag) throw new Error(`FS1 tag ${got} is not ${tag}`);
}

function readNum(r: Reader): number {
  expect(r, T.f64);
  return r.f64();
}

function readStr(r: Reader): string {
  expect(r, T.str);
  const n = r.u32();
  return utf8.decode(r.bytes(n));
}

function readBool(r: Reader): boolean {
  expect(r, T.bool);
  const bit = r.u8();
  if (bit !== 0 && bit !== 1) throw new Error("FS1 boolean is not 0 or 1");
  return bit === 1;
}

function readList<T>(r: Reader, readItem: () => T): T[] {
  expect(r, T.list);
  const n = r.u32();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(readItem());
  return out;
}

function readMap<V>(r: Reader, readValue: () => V): Map<string, V> {
  expect(r, T.map);
  const n = r.u32();
  const out = new Map<string, V>();
  for (let i = 0; i < n; i++) out.set(readStr(r), readValue());
  return out;
}

function readRec(r: Reader, typeId: number, fields: number) {
  expect(r, T.rec);
  const gotType = r.u8();
  const gotFields = r.u8();
  if (gotType !== typeId || gotFields !== fields) {
    throw new Error(`FS1 record ${gotType}/${gotFields} is not ${typeId}/${fields}`);
  }
}

function readCouplings(r: Reader): Couplings {
  readRec(r, R.couplings, 5);
  return {
    hash: readNum(r),
    structural: readNum(r),
    continuity: readNum(r),
    mempool: readNum(r),
    fees: readNum(r),
  };
}

function readAccount(r: Reader): AccountState {
  readRec(r, R.account, 2);
  return { balance: readNum(r), nonce: readNum(r) };
}

function readPool(r: Reader): DexPool {
  readRec(r, R.pool, 8);
  return {
    id: readStr(r),
    tokenA: readStr(r),
    tokenB: readStr(r),
    reserveA: readNum(r),
    reserveB: readNum(r),
    fee: readNum(r),
    txCount: readNum(r),
    address: readStr(r),
  };
}

function readBtc(r: Reader): BtcHeaderRecord {
  readRec(r, R.btc, 5);
  return {
    hash: readStr(r),
    height: readNum(r),
    prevHash: readStr(r),
    merkleRoot: readStr(r),
    bits: readNum(r),
  };
}

function readEth(r: Reader): EthHeaderRecord {
  readRec(r, R.eth, 7);
  return {
    slot: readNum(r),
    hash: readStr(r),
    parentRoot: readStr(r),
    stateRoot: readStr(r),
    bodyRoot: readStr(r),
    participants: readNum(r),
    participation: readStr(r),
  };
}

function readValidator(r: Reader): ValidatorRecord {
  readRec(r, R.validator, 9);
  return {
    address: readStr(r),
    moniker: readStr(r),
    bondedStake: readNum(r),
    accumulatedRewards: readNum(r),
    slashed: readBool(r),
    jailed: readBool(r),
    uptime: readNum(r),
    blocksProposed: readNum(r),
    commission: readNum(r),
  };
}

function readDelegation(r: Reader): Delegation {
  readRec(r, R.delegation, 3);
  return { delegator: readStr(r), validator: readStr(r), amount: readNum(r) };
}

function readUnbonding(r: Reader): Unbonding {
  readRec(r, R.unbonding, 4);
  return { delegator: readStr(r), validator: readStr(r), amount: readNum(r), matureAt: readNum(r) };
}

function readStrPayload(r: Reader): string {
  const n = r.u32();
  return utf8.decode(r.bytes(n));
}

function readWithdrawal(r: Reader): Withdrawal {
  readRec(r, R.withdrawal, 11);
  const row = {
    id: readStr(r),
    sender: readStr(r),
    amount: readNum(r),
    network: readStr(r) as Withdrawal["network"],
    asset: readStr(r),
    destination: readStr(r),
    nonce: readNum(r),
    createdHeight: readNum(r),
    expiryHeight: readNum(r),
    status: readStr(r) as Withdrawal["status"],
  };
  const tag = r.u8();
  if (tag === T.absent) return row as Withdrawal;
  if (tag === T.null) return { ...row, effectLocator: null };
  if (tag !== T.str) throw new Error("FS1 effect locator tag");
  return { ...row, effectLocator: readStrPayload(r) };
}

function readBallot(r: Reader): { voter: string; option: "yes" | "no" | "abstain" } {
  readRec(r, R.ballot, 2);
  return { voter: readStr(r), option: readStr(r) as "yes" | "no" | "abstain" };
}

function readProposal(r: Reader): Proposal {
  readRec(r, R.proposal, 11);
  const row: Proposal = {
    id: readNum(r),
    title: readStr(r),
    proposer: readStr(r),
    deposit: readNum(r),
    yes: readNum(r),
    no: readNum(r),
    abstain: readNum(r),
    status: readStr(r) as Proposal["status"],
  };
  const ballotsTag = r.u8();
  if (ballotsTag === T.list) {
    const n = r.u32();
    const ballots = [];
    for (let i = 0; i < n; i++) ballots.push(readBallot(r));
    row.ballots = ballots;
  } else if (ballotsTag !== T.absent && ballotsTag !== T.null) {
    throw new Error("FS1 ballots tag");
  }
  const keyTag = r.u8();
  if (keyTag === T.str) row.couplingKey = readStrPayload(r) as Proposal["couplingKey"];
  else if (keyTag !== T.absent && keyTag !== T.null) throw new Error("FS1 coupling key tag");
  const valueTag = r.u8();
  if (valueTag === T.f64) row.couplingValue = r.f64();
  else if (valueTag !== T.absent && valueTag !== T.null) throw new Error("FS1 coupling value tag");
  return row;
}

function readModel(r: Reader): ModelClaim {
  readRec(r, R.model, 6);
  return {
    id: readNum(r),
    uri: readStr(r),
    residualFp: readNum(r),
    supportHash: readStr(r),
    status: readStr(r) as ModelClaim["status"],
    proposedAt: readNum(r),
  };
}

function readSettlement(r: Reader): Settlement {
  readRec(r, R.settlement, 7);
  return {
    id: readNum(r),
    asset: readStr(r) as Settlement["asset"],
    foreignRef: readStr(r),
    from: readStr(r),
    to: readStr(r),
    amount: readNum(r),
    status: readStr(r) as Settlement["status"],
  };
}

function readExecution(r: Reader): EthExecutionHeader {
  readRec(r, R.execution, 5);
  return {
    hash: readStr(r),
    parentHash: readStr(r),
    receiptsRoot: readStr(r),
    transactionsRoot: readStr(r),
    number: readNum(r),
  };
}

/** Inverse of encodeOmega. A trailing byte is a refusal. */
export function decodeOmega(bytes: Uint8Array): Omega {
  const r = new Reader(bytes);
  const magic = utf8.decode(r.bytes(4));
  if (magic !== "EQFS") throw new Error("FS1 magic");
  if (r.u8() !== FULL_STATE_VERSION) throw new Error("FS1 version");
  readRec(r, R.omega, 22);
  const chainId = readNum(r);
  const height = readNum(r);
  const tipHash = readStr(r);
  const tipTimestamp = readNum(r);
  const difficulty = readNum(r);
  const couplingsOf = readCouplings(r);
  const ledger = readMap(r, () => readAccount(r));
  const pools = readList(r, () => readPool(r));
  const btcRows = readList(r, () => readBtc(r));
  const ethPubkey = readStr(r);
  const committeeTag = r.u8();
  let ethCommittee: string | undefined;
  if (committeeTag === T.str) ethCommittee = readStrPayload(r);
  else if (committeeTag === T.null) ethCommittee = undefined;
  else if (committeeTag !== T.absent) throw new Error("FS1 committee tag");
  const ethRows = readList(r, () => readEth(r));
  const wasm = readMap(r, () => readStr(r));
  const validators = readMap(r, () => readValidator(r));
  const delegations = readList(r, () => readDelegation(r));
  const unbondingRows = readList(r, () => readUnbonding(r));
  const withdrawals = readList(r, () => readWithdrawal(r));
  const executionTag = r.u8();
  let ethExecution: EthExecutionHeader[] | undefined;
  if (executionTag === T.list) {
    const n = r.u32();
    ethExecution = [];
    for (let i = 0; i < n; i++) ethExecution.push(readExecution(r));
  } else if (executionTag === T.null || executionTag === T.absent) {
    ethExecution = undefined;
  } else throw new Error("FS1 execution tag");
  const proposals = readList(r, () => readProposal(r));
  const models = readList(r, () => readModel(r));
  const settlements = readList(r, () => readSettlement(r));
  const finalizedHeight = readNum(r);
  r.done();
  const omega = {
    chainId,
    height,
    tipHash,
    tipTimestamp,
    difficulty,
    couplings: couplingsOf,
    ledger,
    pools,
    btc: btcRows,
    ethPubkey,
    eth: ethRows,
    wasm,
    validators,
    delegations,
    unbonding: unbondingRows,
    withdrawals,
    proposals,
    models,
    settlements,
    finalizedHeight,
  } as Omega;
  if (committeeTag === T.absent) {
    /* hole stays absent */
  } else if (committeeTag === T.null) {
    (omega as { ethCommittee: string | null }).ethCommittee = null as unknown as string;
  } else {
    omega.ethCommittee = ethCommittee ?? "";
  }
  if (executionTag === T.list) omega.ethExecution = ethExecution ?? [];
  else if (executionTag === T.null) (omega as { ethExecution: EthExecutionHeader[] | null }).ethExecution = null;
  return omega;
}
