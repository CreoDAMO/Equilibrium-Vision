/**
 * Independent EQU. Genesis pays A through G once.
 * A pays B. The process dies. A new process restores the body.
 * B still owns the payment, and B pays A back.
 * No ledger credit after the organism is born.
 */
import { OrganismNode } from "./chain";
import { stringifyCanonical } from "./domain";
import { independentVerify, forgeResidual } from "./light";
import { NETWORKS } from "./networks";
import type { PersistedBody } from "./types";
import { generateKeypair, signTx, type Keypair } from "./wallet";
import assert from "node:assert/strict";

function balance(node: OrganismNode, address: string): number {
  return node.ledger.get(address)?.balance ?? 0;
}

function pay(node: OrganismNode, from: Keypair, to: string, amount: number, fee: number) {
  const nonce = node.ledger.get(from.address)?.nonce ?? 0;
  const tx = signTx(from, { to, amount, fee, nonce, chainId: node.params.chainId });
  const queued = node.submitTx(tx);
  assert.equal(queued.ok, true, queued.error ?? "rejected");
  const before = node.height;
  const block = node.mine();
  assert.equal(node.height, before + 1, "the transfer did not become a block");
  assert.ok(block.transactions.some((t) => t.hash === tx.hash), "the block did not carry the transfer");
  assert.equal(block.verified, true, block.verifyNotes.join("; "));
  return block;
}

if (process.argv.includes("--resume")) {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  process.stdin.on("end", () => {
    const saved = JSON.parse(Buffer.concat(chunks).toString()) as {
      body: PersistedBody;
      a: string;
      b: Keypair;
      b0: number;
      a0: number;
      height: number;
      hash: string;
    };
    const node = OrganismNode.restore("testnet", saved.body);
    assert.equal(node.height, saved.height);
    assert.equal(node.tip?.hash, saved.hash);
    assert.equal(balance(node, saved.b.address), saved.b0);
    assert.equal(balance(node, saved.a), saved.a0);
    const tip = node.tip!;
    const prev = node.blocks[node.blocks.length - 2] ?? null;
    const seen = independentVerify(tip, prev, NETWORKS.testnet);
    assert.equal(seen.agree, true);
    assert.equal(independentVerify(forgeResidual(tip), prev, NETWORKS.testnet).agree, false);
    const returned = 10_000;
    const fee = 50;
    pay(node, saved.b, saved.a, returned, fee);
    const out = {
      ok: true,
      a: balance(node, saved.a),
      b: balance(node, saved.b.address),
      height: node.height,
    };
    assert.equal(out.b, saved.b0 - returned - fee);
    assert.equal(out.a, saved.a0 + returned);
    console.log(JSON.stringify(out));
  });
} else {
  const node = new OrganismNode("testnet");
  const a = generateKeypair();
  const b = generateKeypair();
  assert.equal(balance(node, a.address), 0);
  assert.equal(balance(node, b.address), 0);
  assert.notEqual(a.address, b.address);
  assert.notEqual(a.address, node.treasury.address);

  const endowed = 50_000;
  pay(node, node.treasury, a.address, endowed, 100);
  assert.equal(balance(node, a.address), endowed);

  const sent = 20_000;
  const fee = 100;
  const block = pay(node, a, b.address, sent, fee);
  const prev = node.blocks[node.blocks.length - 2] ?? null;
  const light = independentVerify(block, prev, NETWORKS.testnet);
  assert.equal(light.agree, true, "mobile observation disagreed with the block it was shown");
  assert.equal(independentVerify(forgeResidual(block), prev, NETWORKS.testnet).agree, false);

  const a0 = balance(node, a.address);
  const b0 = balance(node, b.address);
  assert.equal(a0, endowed - sent - fee);
  assert.equal(b0, sent);
  console.log(stringifyCanonical({
    body: node.toBody(),
    a: a.address,
    b,
    a0,
    b0,
    height: node.height,
    hash: node.tip?.hash,
    mobileAgrees: light.agree,
  }));
}
