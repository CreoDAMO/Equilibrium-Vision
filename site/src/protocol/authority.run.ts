/**
 * Who is allowed to decide the next canonical value.
 * Measured, not classified in advance.
 */
import assert from "node:assert/strict";
import { btcHeaderHash, BTC_GENESIS_HEADER_HEX as artifactsGenesis } from "../../../artifacts/api-server/src/chain/btc-header";
import { BTC_GENESIS_HEADER_HEX, decodeHeaderHex, parseBtcHeader, verifyBtcPow } from "./btc";

const raw = decodeHeaderHex(BTC_GENESIS_HEADER_HEX);
assert.ok(raw, "genesis header decodes");
assert.equal(verifyBtcPow(raw), true);
const kernelHash = parseBtcHeader(raw).hash;
assert.equal(artifactsGenesis, BTC_GENESIS_HEADER_HEX);
assert.equal(btcHeaderHash(BTC_GENESIS_HEADER_HEX), kernelHash);
assert.equal(btcHeaderHash("00".repeat(80)), null);
assert.equal(kernelHash, "6fe28c0ab6f1b372c1a6a246ae63f74f931e8365e15a089c68d6190000000000");

console.log(JSON.stringify({
  ok: true,
  btcTip: kernelHash,
  bareHeaderRefused: true,
}));
