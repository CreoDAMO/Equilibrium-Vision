import * as ed from "@noble/ed25519";

export async function deriveAddress(pubKeyHex: string): Promise<string> {
  const data = new TextEncoder().encode(pubKeyHex);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 40);
}

export async function generateWallet() {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const privHex = ed.etc.bytesToHex(privateKey);
  const pubHex = ed.etc.bytesToHex(publicKey);
  const address = await deriveAddress(pubHex);
  
  return {
    privateKey: privHex,
    publicKey: pubHex,
    address
  };
}

export async function importFromPrivKey(privHex: string) {
  const privateKey = ed.utils.hexToBytes(privHex);
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  const pubHex = ed.etc.bytesToHex(publicKey);
  const address = await deriveAddress(pubHex);
  
  return {
    privateKey: privHex,
    publicKey: pubHex,
    address
  };
}

export async function signTx(privHex: string, from: string, to: string, amount: number, fee: number, nonce: number) {
  const msg = new TextEncoder().encode(`${from}${to}${amount}${fee}${nonce}`);
  const sig = await ed.signAsync(msg, privHex);
  const sigHex = ed.etc.bytesToHex(sig);
  return sigHex;
}
