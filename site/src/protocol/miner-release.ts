/**
 * The only miner release the public site offers.
 * The phone reads GET /api/miner/release. It does not ask GitHub.
 * published is true only for the signed file named below.
 */
export const MINER_RELEASE = {
  product: "equilibrium-miner",
  version: "0.4.0",
  versionCode: 4,
  published: true,
  notes:
    "Signed release of commit 74072eb. Mainnet and testnet are selected in the miner. Work and submission name that network. Peer gossip stays off. This page is the only download.",
  sha256: "f6dfc6d8034c2f596cd4c8c69165f59f883dcff1dfe5e1e652feb46ac540b174",
  sizeBytes: 32934461,
  apkUrl: "https://equilibriums.site/downloads/equilibrium-miner-0.4.0.apk",
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
