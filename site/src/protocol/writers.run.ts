/**
 * Ordinary runtime does not mutate Ω before G.
 * propose stages. Mining does not bond. A successor whose Ω moved is stale.
 * residualFp on the public nonce-6 vector is the binary64 integer, not the real-number one.
 */
import assert from "node:assert/strict";
import { OrganismNode } from "./chain";
import { evaluateResidual, type SolverHeader } from "./solver";
import { DEFAULT_COUPLINGS } from "./types";

const node = new OrganismNode("testnet");
const before = node.proposals.length;
const proposer = [...node.validators.values()].find((v) => v.address !== node.miner.address)!.address;
const balance = node.getAccount(proposer).balance;
const proposed = node.propose(proposer, "stage only", 1);
assert.equal(proposed.ok, true, proposed.error);
assert.equal(node.proposals.length, before, "propose wrote Ω");
assert.equal(node.getAccount(proposer).balance, balance, "propose debited the ledger");
const voted = node.vote(proposer, proposed.id!, "yes");
assert.equal(voted.ok, true, voted.error);

const mined = node.mine(node.tip!.timestamp + 1);
assert.equal(mined.verified, true, mined.verifyNotes.join("; "));
assert.ok(node.proposals.some((p) => p.id === proposed.id), "G did not install the staged proposal");
assert.equal(node.getAccount(proposer).balance, balance - 1);

const bare = node.fork();
bare.validators.delete(bare.miner.address);
assert.throws(() => bare.mine(bare.tip!.timestamp + 1), /miner is not a live validator/);

const header: SolverHeader = {
  prevHash: "0".repeat(64),
  merkleRoot: "0".repeat(64),
  timestamp: 1_700_000_000,
  nonce: 6,
  difficulty: 1_000_000,
};
const fp = evaluateResidual(header, [], { cumulativeWork: 1, mempoolPressure: 0 }, DEFAULT_COUPLINGS).canonicalFp;
assert.equal(fp, 201_100_202_523_998);

console.log(JSON.stringify({
  ok: true,
  staged: proposed.id,
  installed: node.proposals.some((p) => p.id === proposed.id),
  bondRefused: true,
  residualFp: fp,
}));
