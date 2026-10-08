/**
 * Wallet → mobile → canonical transfer.
 * The phone's miner address is the wallet address. The key stays with the signer.
 * A transfer is this signature. A delegate or unbond signature is not.
 * External settlement is not this path.
 */
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyCanonicalTx } from "../../../artifacts/api-server/src/lib/canonical-tx.ts";
import { signAuthority } from "./authority";
import { hexToBytes } from "./bytes";
import { applySuccessor, cloneOmega, initialOmega, openedCouplings } from "./constitution";
import { blankEvidence } from "./seal";
import { generatePhrase, signTx, verifyTx, walletFromMnemonic } from "./wallet";

const born = initialOmega("mainnet");
const phrase = generatePhrase();
const again = walletFromMnemonic(phrase);
const payer = walletFromMnemonic(phrase);
assert.equal(payer.address, again.address);
assert.equal(payer.publicKey, again.publicKey);
assert.equal(payer.derivationPath, "m/44'/600'/0'/0'/0'");

const recipient = walletFromMnemonic(generatePhrase());
assert.notEqual(recipient.address, payer.address);
const miner = [...born.validators.values()].find((v) => !v.jailed && !v.slashed && v.bondedStake > 0);
if (!miner) throw new Error("no miner");

const chainId = born.chainId;
const tx = signTx(payer, { to: recipient.address, amount: 1_000, fee: 10, nonce: 0, chainId, timestamp: 1_700_000_000 });
assert.equal(verifyTx(tx, chainId), true);
assert.equal(verifyTx({ ...tx, amount: 1_001 }, chainId), false);

const delegated = signAuthority(payer, { op: "delegate", chainId, validator: miner.address, amount: 1_000 });
assert.equal(verifyTx({ ...tx, signature: delegated.signature, publicKey: delegated.publicKey }, chainId), false);
const unbonded = signAuthority(payer, { op: "unbond", chainId, validator: miner.address, amount: 1_000 });
assert.equal(verifyTx({ ...tx, signature: unbonded.signature }, chainId), false);

const door = verifyCanonicalTx({ ...tx, chainId });
assert.equal(door.ok, true);
if (!door.ok) throw new Error(door.error);
assert.equal(door.hash, tx.hash);
assert.equal(verifyCanonicalTx({ ...tx, chainId, amount: 1_001 }).ok, false);
assert.equal(verifyCanonicalTx({ ...tx, chainId: chainId + 1 }).ok, false);
assert.equal(verifyCanonicalTx({ ...tx, chainId, signature: undefined, publicKey: undefined, hash: undefined }).ok, false);

const utf8 = new TextEncoder().encode(`${tx.from}${tx.to}${tx.amount}${tx.fee}${tx.nonce}`);
const wrongDomain = Buffer.from(ed25519.sign(utf8, hexToBytes(payer.privateKey))).toString("hex");
assert.equal(verifyCanonicalTx({ ...tx, chainId, signature: wrongDomain }).ok, false);

const funded = cloneOmega(born);
funded.ledger.set(payer.address, { balance: 5_000, nonce: 0 });
const moved = applySuccessor(funded, {
  transactions: [tx],
  evidence: blankEvidence(chainId),
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: miner.address,
  committedPressure: 0,
  couplings: openedCouplings(funded),
  difficulty: funded.difficulty,
  wasmAfter: null,
});
assert.equal(moved.ok, true);
if (!moved.ok) throw new Error(moved.error);
assert.equal(moved.next.ledger.get(payer.address)?.balance, 3_990);
assert.equal(moved.next.ledger.get(recipient.address)?.balance, 1_000);
assert.equal(funded.ledger.get(recipient.address)?.balance, undefined);

const tampered = applySuccessor(funded, {
  transactions: [{ ...tx, amount: 1_001 }],
  evidence: blankEvidence(chainId),
  timestamp: 1_700_000_000,
  nonce: 6n,
  miner: miner.address,
  committedPressure: 0,
  couplings: openedCouplings(funded),
  difficulty: funded.difficulty,
  wasmAfter: null,
});
assert.equal(tampered.ok, false);
if (tampered.ok) throw new Error("altered transfer applied");
assert.equal(tampered.error, "signature refused");

console.log(JSON.stringify({
  ok: true,
  address: payer.address,
  path: payer.derivationPath,
  sent: 1000,
  received: moved.next.ledger.get(recipient.address)?.balance,
  external: "not this signature",
}));
