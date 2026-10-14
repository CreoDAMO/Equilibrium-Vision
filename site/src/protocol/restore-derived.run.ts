/**
 * A saved body is served only as the organism its blocks replay to.
 * A broken block is refused. A rewritten ledger is not the served ledger.
 */
import assert from "node:assert/strict";
import { OrganismNode, RestoreRefused } from "./chain";

const node = new OrganismNode("testnet");
const body = node.toBody();
const derived = await OrganismNode.restoreDerived("testnet", body);
assert.equal(derived.tip?.hash, node.tip?.hash);
assert.equal(derived.tip?.stateRoot, node.tip?.stateRoot);
assert.equal(derived.height, node.height);

const address = node.miner.address;
const honest = node.getAccount(address).balance;
const rewritten = {
  ...body,
  accounts: (body.accounts ?? []).map(([key, account]) =>
    key === address ? [key, { ...account, balance: honest + 1_000_000 }] : [key, account],
  ) as typeof body.accounts,
};
const ignored = await OrganismNode.restoreDerived("testnet", rewritten);
assert.equal(ignored.getAccount(address).balance, honest);

const broken = {
  ...body,
  blocks: body.blocks.map((block, index) =>
    index === body.blocks.length - 1 ? { ...block, stateRoot: "ab".repeat(32) } : block,
  ),
};
await assert.rejects(() => OrganismNode.restoreDerived("testnet", broken), RestoreRefused);

console.log(JSON.stringify({ ok: true, height: derived.height, balance: honest }));
