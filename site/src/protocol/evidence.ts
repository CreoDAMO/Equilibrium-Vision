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
        ? `b:${e.pubkey}`
        : `h:${e.slot}:${e.proposerIndex}:${e.parentRoot}:${e.stateRoot}:${e.bodyRoot}:${e.participants}:${e.signature}`,
    )
    .join(";");
  const wasm = ev.wasm.map((w) => `${w.method}:${w.caller}`).join(";");
  const stake = ev.stake
    .map((s) => {
      if (s.op === "delegate") return `d:${s.delegator}:${s.validator}:${s.amount}`;
      if (s.op === "claim") return `c:${s.address}`;
      if (s.op === "slash") return `s:${s.validator}:${s.reason}`;
      if (s.op === "vote") return `v:${s.voter}:${s.id}:${s.option}`;
      return `p:${s.id}:${s.proposer}:${s.deposit}:${encodeURIComponent(s.title)}`;
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
  const body = ["v1", String(ev.chainId), ev.wasmCode, btc, eth, wasm, stake].join("|");
  if (!cognition && !settle) return body;
  return `${body}|${cognition}|${settle}`;
}

export function evidenceRoot(ev: TransitionEvidence): string {
  return sha256Hex(canonicalEvidence(ev));
}
