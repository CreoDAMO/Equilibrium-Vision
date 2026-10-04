/**
 * 2^53+1 is a different constitutional integer from 2^53.
 * A JavaScript number is not that integer.
 */
import assert from "node:assert/strict";
import { decodeU64, decodeU64Decimal, encodeU64, participationBytes, popcount } from "./domain";
import { participationMask } from "./eth-light";

const above = (1n << 53n) + 1n;
assert.equal(decodeU64(encodeU64(above)), above);
assert.equal(Number(above), Number(1n << 53n));
assert.throws(() => encodeU64(-1n), /u64 refused/);
assert.throws(() => decodeU64(new Uint8Array(7)), /u64 refused/);
assert.equal(decodeU64Decimal("18446744073709551615"), (1n << 64n) - 1n);
assert.throws(() => decodeU64Decimal("-1"), /u64 refused/);
assert.throws(() => decodeU64Decimal("1.5"), /u64 refused/);
assert.throws(() => decodeU64Decimal("01"), /u64 refused/);
assert.throws(() => decodeU64Decimal("18446744073709551616"), /u64 refused/);

const bits = participationBytes(Buffer.from(participationMask(342)).toString("hex"));
assert.equal(popcount(bits), 342);
assert.equal(popcount(participationBytes(Buffer.from(participationMask(400)).toString("hex"))), 400);
assert.throws(() => participationBytes("ff"), /participation refused/);

console.log(JSON.stringify({
  ok: true,
  above: above.toString(),
  collapsedInNumber: Number(above) === Number(1n << 53n),
  participantsDerived: popcount(bits),
}));
