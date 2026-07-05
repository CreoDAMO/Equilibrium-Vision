/**
 * generate-genesis.ts
 *
 * Generates the canonical genesis.json for Equilibrium Mainnet and a
 * companion validator-keys.json (private keys — keep secret, never commit).
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run generate-genesis
 *
 * Output:
 *   genesis.json          — commit this; share with all validators
 *   validator-keys.json   — KEEP SECRET; one entry per initial validator
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createHash } from "node:crypto";
import { generateGenesis, defaultMainnetGenesisConfig } from "@workspace/coinomics";

// Output to the workspace root regardless of which directory pnpm runs from.
const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ── Keypair helpers ──────────────────────────────────────────────────────────

interface ValidatorKey {
  name: string;
  address: string;
  pubkeyHex: string;
  privkeyHex: string;
}

function generateValidatorKeypair(name: string): ValidatorKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  // SPKI DER for Ed25519 is 44 bytes: 12-byte header + 32-byte raw key
  const rawPub = (publicKey as Buffer).slice(-32);
  // PKCS#8 DER for Ed25519: last 32 bytes are the raw private key seed
  const rawPriv = (privateKey as Buffer).slice(-32);
  const address = createHash("sha256").update(rawPub).digest().slice(0, 20).toString("hex");
  return { name, address, pubkeyHex: rawPub.toString("hex"), privkeyHex: rawPriv.toString("hex") };
}

/** Deterministic address from a human-readable label (for allocation accounts). */
function labelAddress(label: string): string {
  return createHash("sha256").update(label).digest().slice(0, 20).toString("hex");
}

// ── Generate validator keypairs ──────────────────────────────────────────────

const validatorKeys: ValidatorKey[] = [
  generateValidatorKeypair("Equilibrium Foundation"),
  generateValidatorKeypair("Equilibrium Labs"),
  generateValidatorKeypair("Community Validator Alpha"),
  generateValidatorKeypair("Community Validator Beta"),
];

console.log("✅ Generated validator keypairs:");
for (const v of validatorKeys) {
  console.log(`   ${v.name}: ${v.address}`);
}

// ── Allocation addresses ─────────────────────────────────────────────────────
// In a real launch these would be real wallet addresses provided by each party.
// We derive them from labels so the script is self-contained and reproducible.

const addresses = {
  community:   labelAddress("equilibrium-community-airdrop-mobile-mining"),
  liquidity:   labelAddress("equilibrium-liquidity-pools-dex-seeding"),
  ecosystem:   labelAddress("equilibrium-ecosystem-development-fund"),
  founderFast: labelAddress("equilibrium-founder-upfront"),
  founderVest: labelAddress("equilibrium-founder-vested"),
  team:        labelAddress("equilibrium-team"),
  advisors:    labelAddress("equilibrium-advisors-early-contributors"),
  staking:     labelAddress("equilibrium-staking-validator-bootstrap"),
  validators: validatorKeys.map((v, i) => ({
    address: v.address,
    name: v.name,
    // Stake allocation (from the 5M staking bootstrap pool):
    // Foundation + Labs each get 1.5M; community validators get 1M each
    stake: i < 2 ? 1_500_000 : 1_000_000,
  })),
};

// ── Build and validate genesis document ─────────────────────────────────────

const timestamp = new Date().toISOString();
const config = defaultMainnetGenesisConfig(timestamp, addresses);
const doc = generateGenesis(config); // throws on validation failure

console.log(`\n📋 Genesis summary:`);
console.log(`   chain_id:        ${doc.chain_id}`);
console.log(`   timestamp:       ${doc.timestamp}`);
console.log(`   initial_supply:  ${doc.initial_supply} EQU`);
console.log(`   allocations:     ${doc.allocations.length} entries`);
console.log(`   validators:      ${doc.initial_validators.length}`);
console.log(`   dex_pools:       ${doc.dex_pools.length}`);

const totalAllocated = doc.allocations.reduce((s, a) => s + Number(a.amount), 0);
console.log(`   total allocated: ${totalAllocated.toLocaleString()} EQU`);

// ── Write output files ───────────────────────────────────────────────────────

const genesisPath = resolve(WORKSPACE_ROOT, "genesis.json");
writeFileSync(genesisPath, JSON.stringify(doc, null, 2) + "\n");
console.log(`\n✅ Written: ${genesisPath}`);

// validator-keys.json — NEVER commit this file
const keysPath = resolve(WORKSPACE_ROOT, "validator-keys.json");
writeFileSync(
  keysPath,
  JSON.stringify(
    {
      _warning: "KEEP SECRET — never commit this file. Each validator operator should receive only their own entry.",
      generated_at: timestamp,
      validators: validatorKeys,
    },
    null,
    2,
  ) + "\n",
);
console.log(`✅ Written: ${keysPath}  ← KEEP SECRET, do not commit`);
console.log("\n🚀 Genesis block is ready. Share genesis.json with all validators.");
