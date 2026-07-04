#!/usr/bin/env node
// ── CLI wrapper: write genesis.json to disk ──────────────────────────────────
//
// Thin I/O shell around the pure `generateGenesis` function so the generator
// module itself stays side-effect-free and testable. Usage:
//
//   pnpm --filter @workspace/coinomics run generate-genesis [outputPath]
//
// Defaults to writing `genesis.json` in the current working directory using
// the default mainnet allocation split with placeholder addresses — replace
// those addresses before ever using this for a real launch.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultMainnetGenesisConfig, generateGenesis } from "../genesis.js";

const outputPath = resolve(process.argv[2] ?? "genesis.json");
const timestamp = new Date().toISOString();

const config = defaultMainnetGenesisConfig(timestamp);
const document = generateGenesis(config);

writeFileSync(outputPath, JSON.stringify(document, null, 2) + "\n", "utf-8");

console.log(`Genesis document written to ${outputPath}`);
console.log(`  chain_id:       ${document.chain_id}`);
console.log(`  timestamp:      ${document.timestamp}`);
console.log(`  initial_supply: ${document.initial_supply} EQU`);
console.log(`  allocations:    ${document.allocations.length}`);
console.log(`  validators:     ${document.initial_validators.length}`);
console.log(`  dex_pools:      ${document.dex_pools.length}`);
