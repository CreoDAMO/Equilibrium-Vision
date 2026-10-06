import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/**
 * A caller string is not authority.
 * The signer must be the address, and the signature must bind this action's body.
 * publicKey and signature are not part of the signed body.
 */
export function authorityMessage(action: string, body: unknown): string {
  return `authority:${action}:${stableString(stripProof(body))}`;
}

export function addressFromPublicKey(publicKeyHex: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyHex, "hex")).digest("hex").slice(0, 40);
}

export function verifyEd25519(publicKeyHex: string, signatureHex: string, message: string): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || !/^[0-9a-f]{128}$/.test(signatureHex)) return false;
    const raw = Buffer.from(publicKeyHex, "hex");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

export function authorizeCaller(
  body: unknown,
  action: string,
  identityField = "caller",
): { ok: true; caller: string } | { ok: false; status: number; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "caller signature is required" };
  }
  const record = body as Record<string, unknown>;
  const claimed = typeof record[identityField] === "string" ? record[identityField].trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(claimed)) {
    return { ok: false, status: 400, error: `${identityField} (40-hex-char address) is required` };
  }
  const publicKey = typeof record.publicKey === "string" ? record.publicKey.trim().toLowerCase() : "";
  const signature = typeof record.signature === "string" ? record.signature.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(publicKey) || !/^[0-9a-f]{128}$/.test(signature)) {
    return { ok: false, status: 401, error: "publicKey and signature are required to prove the caller" };
  }
  if (addressFromPublicKey(publicKey) !== claimed) {
    return { ok: false, status: 401, error: "publicKey does not correspond to caller address" };
  }
  const message = authorityMessage(action, record);
  if (!verifyEd25519(publicKey, signature, message)) {
    return { ok: false, status: 401, error: "caller signature refused" };
  }
  return { ok: true, caller: claimed };
}

function stripProof(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(body as object)) {
    if (key === "publicKey" || key === "signature") continue;
    rest[key] = (body as Record<string, unknown>)[key];
  }
  return rest;
}

function stableString(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  const keys = Object.keys(value as object).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableString((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
