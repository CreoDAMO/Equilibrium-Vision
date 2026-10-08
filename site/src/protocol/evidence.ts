import { sha256Hex } from "./crypto";
import { ARBITRAGE_WASM } from "./arbitrage-wasm";
import type { TransitionEvidence } from "./types";

/** Hash of the wasm32 arbitrage binary this constitution executes. */
export const ARBITRAGE_CODE = sha256Hex(ARBITRAGE_WASM);

/**
 * Canonical encoding of the inputs that are not transactions.
 * A second body replays this string. It does not replay hidden memory.
 */
export function canonicalEvidence(ev: TransitionEvidence): string {
  const btc = ev.btc.map((b) => `${b.height}:${b.headerHex}`).join(";");
  const eth = ev.eth
    .map((e) =>
      e.op === "bootstrap"
        ? `b:${e.committee}:${e.aggregate}`
        : e.op === "rotate"
          ? `r:${e.committee}:${e.aggregate}:${e.participation}:${e.signature}`
          : `h:${e.slot}:${e.proposerIndex}:${e.parentRoot}:${e.stateRoot}:${e.bodyRoot}:${e.participation}:${e.signature}`,
    )
    .join(";");
  const wasm = ev.wasm.map((w) => `${w.method}:${w.caller}`).join(";");
  const stake = ev.stake
    .map((s) => {
      if (s.op === "delegate") {
        const publicKey = s.publicKey ?? "";
        const signature = s.signature ?? "";
        if (publicKey !== "" || signature !== "") {
          return `a:${s.delegator}:${s.validator}:${s.amount}:${publicKey}:${signature}`;
        }
        return `d:${s.delegator}:${s.validator}:${s.amount}`;
      }
      if (s.op === "unbond") {
        return `u:${s.delegator}:${s.validator}:${s.amount}:${s.publicKey ?? ""}:${s.signature ?? ""}`;
      }
      if (s.op === "claim") return `c:${s.address}`;
      if (s.op === "slash") return `s:${s.validator}:${s.reason}`;
      if (s.op === "vote") return `v:${s.voter}:${s.id}:${s.option}`;
      const proposed = `p:${s.id}:${s.proposer}:${s.deposit}:${encodeURIComponent(s.title)}`;
      if (s.couplingKey && typeof s.couplingValue === "number") {
        return `${proposed}:${s.couplingKey}:${s.couplingValue}`;
      }
      return proposed;
    })
    .join(";");
  const cognition = (ev.cognition ?? [])
    .map((c) => {
      if (c.kind === "bind") return `b:${c.residualFp}:${c.proof}`;
      if (c.kind === "challenge") return `x:${c.id}:${c.supportHash}:${c.proof}`;
      return `m:${c.id}:${c.residualFp}:${c.supportHash}:${c.proof}:${encodeURIComponent(c.uri)}`;
    })
    .join(";");
  const settle = (ev.settle ?? [])
    .map((s) =>
      s.op === "lock"
        ? `l:${s.id}:${s.asset}:${s.foreignRef}:${s.from}:${s.to}:${s.amount}`
        : `r:${s.id}`,
    )
    .join(";");
  const withdraw = (ev.withdraw ?? [])
    .map((w) =>
      w.op === "open"
        ? `o:${w.sender}:${w.amount}:${w.network}:${w.asset}:${w.destination}:${w.nonce}:${w.publicKey ?? ""}:${w.signature ?? ""}`
        : `s:${w.id}:${w.headerHash}:${w.vout}:${w.rawTx}:${w.merkle.join(",")}`,
    )
    .join(";");
  const body = ["v1", String(ev.chainId), ev.wasmCode, btc, eth, wasm, stake].join("|");
  if (!cognition && !settle && !withdraw) return body;
  if (!withdraw) return `${body}|${cognition}|${settle}`;
  return `${body}|${cognition}|${settle}|${withdraw}`;
}

export function evidenceRoot(ev: TransitionEvidence): string {
  return sha256Hex(canonicalEvidence(ev));
}
