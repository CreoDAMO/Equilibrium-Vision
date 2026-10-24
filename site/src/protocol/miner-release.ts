/**
 * The only miner release the public site offers.
 * The phone reads GET /api/miner/release. It does not ask GitHub.
 * Leave published false until the APK URL and SHA-256 are the build you mean to ship.
 */
export const MINER_RELEASE = {
  product: "equilibrium-miner",
  version: "0.4.0",
  versionCode: 4,
  published: false,
  notes:
    "Mainnet and testnet are selected in the miner. Work and submission name that network. Peer gossip stays off until it is isolated. This page is the download.",
  sha256: "",
  sizeBytes: 0,
  apkUrl: "",
} as const;

export type MinerRelease = {
  product: string;
  version: string;
  versionCode: number;
  published: boolean;
  notes: string;
  sha256: string;
  sizeBytes: number;
  apkUrl: string;
};
