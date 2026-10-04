/**
 * The nine capabilities, as four membranes.
 * A proof that does not name G's residual is refused.
 * A model enters Ω only after G recomputes the commitment.
 * Settlement pays EQU that was locked, against a header already observed.
 * The phone searches or waits. It does not install a successor.
 */
import assert from "node:assert/strict";
import { BTC_GENESIS_HEADER_HEX, decodeHeaderHex, parseBtcHeader } from "./btc";
import { OrganismNode } from "./chain";
import { applySuccessor, initialOmega, omegaDigest, openedCouplings } from "./constitution";
import { ARBITRAGE_CODE } from "./evidence";
import {
  bootstrapCode,
  mobileCandidate,
  modelBinding,
  parseBootstrap,
  participation,
  persistPeers,
  remember,
  residualBinding,
  restorePeers,
} from "./membranes";
import { onPlaneMessage } from "./network-plane";
import { minerKey } from "./genesis";
import type { TransitionEvidence } from "./types";

function evidence(extra: Partial<TransitionEvidence> = {}): TransitionEvidence {
  return {
    v: 1,
    chainId: 1,
    wasmCode: ARBITRAGE_CODE,
    btc: [],
    eth: [],
    wasm: [],
    stake: [],
    ...extra,
  };
}

const omega = initialOmega("mainnet");
const miner = minerKey("mainnet").address;
const base = {
  transactions: [],
  timestamp: 1_700_000_000,
  nonce: 1n,
  miner,
  committedPressure: 0,
  couplings: openedCouplings(omega),
  difficulty: omega.difficulty,
  wasmAfter: null,
};
const dry = applySuccessor(omega, { ...base, evidence: undefined });
assert.equal(dry.ok, true);
if (!dry.ok) throw new Error("dry");

const forged = applySuccessor(omega, {
  ...base,
  evidence: evidence({ cognition: [{ kind: "bind", residualFp: dry.residualFp, proof: "00".repeat(32) }] }),
});
assert.equal(forged.ok, false);

const bound = applySuccessor(omega, {
  ...base,
  evidence: evidence({
    cognition: [{
      kind: "bind",
      residualFp: dry.residualFp,
      proof: residualBinding(dry.residualFp, dry.stateRoot),
    }],
  }),
});
assert.equal(bound.ok, true);
if (!bound.ok) throw new Error("bind");
assert.equal(omegaDigest(bound.next), omegaDigest(dry.next));

const lie = {
  id: 7,
  uri: "ipfs://model",
  residualFp: 1,
  supportHash: "ab".repeat(32),
};
const notAProof = applySuccessor(omega, {
  ...base,
  evidence: evidence({
    cognition: [{ kind: "model", ...lie, proof: modelBinding(1, { ...lie, residualFp: 2 }) }],
  }),
});
assert.equal(notAProof.ok, false);

const node = new OrganismNode("testnet");
assert.equal(node.models.length, 0);
const staged = node.proposeModel("ipfs://equilibrium", 3, "ab".repeat(32));
assert.equal(staged.ok, true);
assert.equal(node.models.length, 0);
node.mine();
assert.equal(node.models.length, 1);
assert.equal(node.models[0]?.status, "bound");
const modelId = node.models[0]!.id;
const challenged = node.challengeModel(modelId, "cd".repeat(32));
assert.equal(challenged.ok, true);
assert.equal(node.models[0]?.status, "bound");
node.mine();
assert.equal(node.models[0]?.status, "slashed");

const stranger = "cd".repeat(20);
assert.equal(node.lockForeign(node.treasury.address, stranger, 1_000, "btc", "ab".repeat(32)).ok, false);
const header = decodeHeaderHex(BTC_GENESIS_HEADER_HEX);
assert.ok(header);
const foreignRef = parseBtcHeader(header!).hash;
assert.equal(node.submitBtcHeader(BTC_GENESIS_HEADER_HEX, 0).ok, true);
const locked = node.lockForeign(node.treasury.address, stranger, 1_000, "btc", foreignRef);
assert.equal(locked.ok, true);
if (!locked.ok) throw new Error("lock");
const treasuryBefore = node.ledger.get(node.treasury.address)?.balance ?? 0;
node.mine();
assert.equal(node.btcHeaders.length, 1);
assert.equal(node.settlements[0]?.status, "locked");
assert.equal(node.ledger.get(node.treasury.address)?.balance, treasuryBefore - 1_000);
assert.equal(node.ledger.get(stranger)?.balance ?? 0, 0);
assert.equal(node.releaseForeign(locked.id).ok, true);
node.mine();
assert.equal(node.settlements[0]?.status, "settled");
assert.equal(node.ledger.get(stranger)?.balance, 1_000);
assert.equal(node.releaseForeign(locked.id).ok, false);

assert.equal(participation({ thermalC: 46, battery: 0.9 }), "defer");
assert.equal(participation({ thermalC: 31, battery: 0.2 }), "verify");
assert.equal(participation({ thermalC: 31, battery: 0.9 }), "solve");
const job = {
  header: {
    prevHash: "11".repeat(32),
    merkleRoot: "22".repeat(32),
    timestamp: 1_700_000_000,
    nonce: 1,
    difficulty: 1_000_000,
  },
  txs: [],
  state: { cumulativeWork: 1, mempoolPressure: 0 },
  maxIter: 4,
  recursionDepth: 1,
  target: 1,
};
assert.equal(mobileCandidate(job, { thermalC: 50, battery: 0.5 }).mode, "defer");
const solved = mobileCandidate(job, { thermalC: 30, battery: 0.8 });
const again = mobileCandidate(job, { thermalC: 30, battery: 0.8 });
assert.equal(solved.mode, "solve");
assert.equal(again.mode, "solve");
if (solved.mode === "solve" && again.mode === "solve") assert.equal(solved.nonce, again.nonce);

const heard = parseBootstrap("eq1:nfc:0123456789abcdef@/ip4/10.0.0.8/tcp/4001");
assert.ok(heard);
assert.equal(parseBootstrap("not a peer"), null);
const book = remember({ peers: [] }, heard!);
const recovered = restorePeers(persistPeers(book));
assert.equal(recovered.peers[0]?.id, heard!.id);
assert.equal(recovered.peers[0]?.via, "nfc");
const shown = parseBootstrap(bootstrapCode({ id: "abcdef0123456789", multiaddr: "/ip4/10.0.0.9/tcp/1", via: "qr" }));
assert.equal(shown?.via, "qr");
const port = { hasBlock: () => false, admit: () => ({ ok: true }) };
const hello = await onPlaneMessage(port, { event: "peer_connected", peerId: heard!.id });
assert.equal(hello.ok, true);
const hashOnly = await onPlaneMessage(port, { event: "block", peerId: heard!.id, blockHash: "ab".repeat(32) });
assert.equal(hashOnly.ok, false);

console.log(JSON.stringify({
  ok: true,
  bind: "refused a proof that did not name the state",
  model: node.models[0]?.status,
  settled: node.ledger.get(stranger)?.balance,
  phone: solved.mode,
  peers: recovered.peers.length,
}));
