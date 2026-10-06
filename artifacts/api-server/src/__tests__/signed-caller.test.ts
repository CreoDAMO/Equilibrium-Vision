import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addressFromPublicKey, authorizeCaller, authorityMessage } from "../lib/signed-caller.js";

function key() {
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const publicKey = raw.toString("hex");
  return { pair, publicKey, caller: addressFromPublicKey(publicKey) };
}

function signBody(pair: ReturnType<typeof key>, action: string, body: Record<string, unknown>) {
  const message = Buffer.from(authorityMessage(action, body), "utf8");
  return sign(null, message, pair.pair.privateKey).toString("hex");
}

describe("signed caller", () => {
  const action = "POST /api/staking/contract/delegate";

  it("rejects a bare caller string", () => {
    const { caller } = key();
    const result = authorizeCaller({ caller, validatorId: 1, amount: 10 }, action);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it("accepts a signature over this action and refuses the same signature on another amount", () => {
    const pair = key();
    const body = { caller: pair.caller, validatorId: 1, amount: 10 };
    const signature = signBody(pair, action, body);
    const signed = { ...body, publicKey: pair.publicKey, signature };
    expect(authorizeCaller(signed, action)).toEqual({ ok: true, caller: pair.caller });
    expect(authorizeCaller({ ...signed, amount: 11 }, action).ok).toBe(false);
    expect(authorizeCaller(signed, "POST /api/staking/contract/undelegate").ok).toBe(false);
  });

  it("refuses a signature from a different key", () => {
    const pair = key();
    const other = key();
    const body = { caller: pair.caller, amount: 1 };
    const signature = signBody(other, action, body);
    expect(authorizeCaller({ ...body, publicKey: other.publicKey, signature }, action).ok).toBe(false);
    expect(authorizeCaller({ ...body, publicKey: pair.publicKey, signature }, action).ok).toBe(false);
  });
});
