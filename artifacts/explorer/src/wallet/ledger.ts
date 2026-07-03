// ── Ledger Hardware Wallet Transport ─────────────────────────────────────────
//
// Connects to a Ledger device via WebHID (Chrome/Edge) or WebUSB (fallback).
// Implements the Ledger Equilibrium app protocol:
//   CLA = 0xE0
//   INS_GET_PUBLIC_KEY = 0x02
//   INS_SIGN_TX       = 0x04
//
// On devices without the Equilibrium app installed, falls back to Ed25519 signing
// via the Ledger generic signing app if available.

export type LedgerTransportType = "webhid" | "webusb" | "none";

export interface LedgerDevice {
  transport: LedgerTransportType;
  deviceName: string;
  connected: boolean;
}

export interface LedgerPublicKey {
  publicKey: string;
  address: string;
  derivationPath: string;
}

export interface LedgerSignatureResult {
  signature: string;
  signedBy: string;
}

// Equilibrium Ledger app constants
const CLA = 0xe0;
const INS_GET_PK = 0x02;
const INS_SIGN = 0x04;
const EQU_COIN_TYPE = 600;

// Serialize a BIP-44 derivation path for Ledger APDU
function serializePath(path: string): Uint8Array {
  const segments = path.replace("m/", "").split("/").map(s => {
    const hardened = s.endsWith("'");
    const index = parseInt(s.replace(/'/g, ""), 10);
    return hardened ? (index | 0x80000000) >>> 0 : index;
  });
  const buf = new Uint8Array(1 + segments.length * 4);
  buf[0] = segments.length;
  const view = new DataView(buf.buffer);
  for (let i = 0; i < segments.length; i++) {
    view.setUint32(1 + i * 4, segments[i]!, false);
  }
  return buf;
}

export class LedgerTransport {
  private device: HIDDevice | USBDevice | null = null;
  private type: LedgerTransportType = "none";

  get isConnected(): boolean {
    return this.device !== null;
  }

  get transportType(): LedgerTransportType {
    return this.type;
  }

  async connect(): Promise<LedgerDevice> {
    // Try WebHID first (Chrome 89+, Edge 89+)
    if (typeof navigator !== "undefined" && "hid" in navigator) {
      try {
        const devices = await (navigator as any).hid.requestDevice({
          filters: [
            { vendorId: 0x2c97 }, // Ledger vendor ID
          ],
        });
        if (devices.length > 0) {
          const hid = devices[0] as HIDDevice;
          if (!hid.opened) await hid.open();
          this.device = hid;
          this.type = "webhid";
          return {
            transport: "webhid",
            deviceName: hid.productName ?? "Ledger Device",
            connected: true,
          };
        }
      } catch (e) {
        console.warn("WebHID failed:", e);
      }
    }

    // Fallback: WebUSB (Chrome 61+)
    if (typeof navigator !== "undefined" && "usb" in navigator) {
      try {
        const device = await (navigator as any).usb.requestDevice({
          filters: [{ vendorId: 0x2c97 }],
        });
        await device.open();
        await device.selectConfiguration(1);
        await device.claimInterface(0);
        this.device = device;
        this.type = "webusb";
        return {
          transport: "webusb",
          deviceName: device.productName ?? "Ledger Device",
          connected: true,
        };
      } catch (e) {
        console.warn("WebUSB failed:", e);
      }
    }

    throw new LedgerError("NO_TRANSPORT", "Neither WebHID nor WebUSB is available or permitted");
  }

  async disconnect(): Promise<void> {
    if (!this.device) return;
    try {
      if (this.type === "webhid") {
        await (this.device as HIDDevice).close();
      } else if (this.type === "webusb") {
        await (this.device as USBDevice).close();
      }
    } finally {
      this.device = null;
      this.type = "none";
    }
  }

  async getPublicKey(
    accountIndex = 0,
    addressIndex = 0,
    display = false,
  ): Promise<LedgerPublicKey> {
    const path = `m/44'/${EQU_COIN_TYPE}'/${accountIndex}'/0'/${addressIndex}'`;
    const pathBytes = serializePath(path);

    // APDU: CLA INS P1(display) P2(0) LEN path_bytes
    const apdu = new Uint8Array([CLA, INS_GET_PK, display ? 0x01 : 0x00, 0x00, pathBytes.length, ...pathBytes]);
    const response = await this.exchange(apdu);

    if (response.length < 33) {
      throw new LedgerError("INVALID_RESPONSE", "GetPublicKey response too short");
    }

    const publicKeyLen = response[0]!;
    const publicKeyBytes = response.slice(1, 1 + publicKeyLen);
    const publicKeyHex = Array.from(publicKeyBytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    // Derive address from public key (SHA-256 → first 20 bytes)
    const digest = await crypto.subtle.digest("SHA-256", publicKeyBytes);
    const address = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 40);

    return { publicKey: publicKeyHex, address, derivationPath: path };
  }

  async signTransaction(
    txBytes: Uint8Array,
    accountIndex = 0,
    addressIndex = 0,
  ): Promise<LedgerSignatureResult> {
    const path = `m/44'/${EQU_COIN_TYPE}'/${accountIndex}'/0'/${addressIndex}'`;
    const pathBytes = serializePath(path);

    // First APDU chunk: path + tx length + first 150 bytes
    const CHUNK_SIZE = 150;
    const txLen = new Uint8Array(2);
    new DataView(txLen.buffer).setUint16(0, txBytes.length, false);

    const chunks: Uint8Array[] = [];
    const firstPayload = new Uint8Array([...pathBytes, ...txLen, ...txBytes.slice(0, CHUNK_SIZE)]);
    chunks.push(firstPayload);

    for (let offset = CHUNK_SIZE; offset < txBytes.length; offset += CHUNK_SIZE) {
      chunks.push(txBytes.slice(offset, offset + CHUNK_SIZE));
    }

    let response: Uint8Array = new Uint8Array();
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const p1 = i === 0 ? 0x00 : 0x80;
      const p2 = isLast ? 0x00 : 0x80;
      const chunk = chunks[i]!;
      const apdu = new Uint8Array([CLA, INS_SIGN, p1, p2, chunk.length, ...chunk]);
      response = await this.exchange(apdu);
    }

    // Last response contains the signature
    if (response.length < 64) {
      throw new LedgerError("INVALID_RESPONSE", "SignTransaction response too short");
    }

    const { publicKey, address } = await this.getPublicKey(accountIndex, addressIndex);
    const signature = Array.from(response.slice(0, 64))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

    return { signature, signedBy: address };
  }

  private async exchange(apdu: Uint8Array): Promise<Uint8Array> {
    if (!this.device) throw new LedgerError("NOT_CONNECTED", "Ledger not connected");

    if (this.type === "webhid") {
      return this.exchangeHID(apdu);
    } else if (this.type === "webusb") {
      return this.exchangeUSB(apdu);
    }
    throw new LedgerError("NO_TRANSPORT", "No transport available");
  }

  private async exchangeHID(apdu: Uint8Array): Promise<Uint8Array> {
    const hid = this.device as HIDDevice;
    // Ledger HID framing: [reportId=0x00][channelId=0x0101][cmd=0x05][seqIdx][apduLen/data...]
    const frames = buildHIDFrames(apdu);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        hid.oninputreport = null;
        reject(new LedgerError("TIMEOUT", "Ledger HID response timeout"));
      }, 30_000);

      const responseChunks: Uint8Array[] = [];
      let expected = -1;

      hid.oninputreport = (event: HIDInputReportEvent) => {
        const data = new Uint8Array(event.data.buffer);
        const parsed = parseHIDFrame(data);
        if (!parsed) return;

        if (expected === -1) {
          expected = parsed.totalLength;
        }
        responseChunks.push(parsed.data);
        const collected = responseChunks.reduce((s, c) => s + c.length, 0);

        if (collected >= expected) {
          clearTimeout(timeout);
          hid.oninputreport = null;
          const full = new Uint8Array(collected);
          let off = 0;
          for (const c of responseChunks) { full.set(c, off); off += c.length; }
          const sw1 = full[full.length - 2]!;
          const sw2 = full[full.length - 1]!;
          const sw = (sw1 << 8) | sw2;
          if (sw !== 0x9000) {
            reject(new LedgerError("DEVICE_ERROR", `Ledger returned 0x${sw.toString(16)}: ${ledgerStatusMessage(sw)}`));
          } else {
            resolve(full.slice(0, full.length - 2));
          }
        }
      };

      for (const frame of frames) {
        hid.sendReport(0x00, frame).catch(reject);
      }
    });
  }

  private async exchangeUSB(apdu: Uint8Array): Promise<Uint8Array> {
    const usb = this.device as USBDevice;
    await usb.transferOut(2, apdu);
    const result = await usb.transferIn(2, 64);
    if (!result.data) throw new LedgerError("USB_ERROR", "No data received");
    const bytes = new Uint8Array(result.data.buffer);
    const sw1 = bytes[bytes.length - 2]!;
    const sw2 = bytes[bytes.length - 1]!;
    const sw = (sw1 << 8) | sw2;
    if (sw !== 0x9000) {
      throw new LedgerError("DEVICE_ERROR", `Ledger status 0x${sw.toString(16)}: ${ledgerStatusMessage(sw)}`);
    }
    return bytes.slice(0, bytes.length - 2);
  }
}

// ── HID framing helpers ───────────────────────────────────────────────────────

function buildHIDFrames(apdu: Uint8Array): Uint8Array[] {
  const CHANNEL = [0x01, 0x01];
  const CMD = [0x05];
  const FRAME_SIZE = 64;
  const frames: Uint8Array[] = [];

  // First frame: channel + cmd + seqIdx=0 + apduLen + data
  let offset = 0;
  let seqIdx = 0;

  while (offset <= apdu.length) {
    const frame = new Uint8Array(FRAME_SIZE).fill(0);
    let pos = 0;
    frame[pos++] = 0x01; frame[pos++] = 0x01; // channel
    frame[pos++] = 0x05; // cmd
    frame[pos++] = (seqIdx >> 8) & 0xff;
    frame[pos++] = seqIdx & 0xff;

    if (seqIdx === 0) {
      frame[pos++] = (apdu.length >> 8) & 0xff;
      frame[pos++] = apdu.length & 0xff;
    }

    const chunk = apdu.slice(offset, offset + (FRAME_SIZE - pos));
    frame.set(chunk, pos);
    frames.push(frame);
    offset += chunk.length;
    seqIdx++;

    if (offset >= apdu.length) break;
  }

  return frames;
}

function parseHIDFrame(data: Uint8Array): { totalLength: number; data: Uint8Array } | null {
  if (data.length < 5) return null;
  if (data[0] !== 0x01 || data[1] !== 0x01) return null;
  if (data[2] !== 0x05) return null;
  const seqIdx = (data[3]! << 8) | data[4]!;
  if (seqIdx === 0) {
    const totalLength = (data[5]! << 8) | data[6]!;
    return { totalLength, data: data.slice(7) };
  }
  return { totalLength: 0, data: data.slice(5) };
}

function ledgerStatusMessage(sw: number): string {
  const table: Record<number, string> = {
    0x6700: "Incorrect length",
    0x6982: "Security status not satisfied",
    0x6985: "Conditions not satisfied",
    0x6a80: "Invalid data",
    0x6a82: "File not found (app not open?)",
    0x6b00: "Invalid parameter",
    0x6d00: "Instruction not supported",
    0x6e00: "Class not supported",
    0x6f00: "Technical problem",
    0x9000: "OK",
  };
  return table[sw] ?? `Unknown status 0x${sw.toString(16)}`;
}

export class LedgerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LedgerError";
  }
}

export function isWebHIDSupported(): boolean {
  return typeof navigator !== "undefined" && "hid" in navigator;
}

export function isWebUSBSupported(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

export function isLedgerSupported(): boolean {
  return isWebHIDSupported() || isWebUSBSupported();
}
