/**
 * Seeds a synthetic, deliberately mispriced WBTC-USDC pool on a running API
 * server so the arbitrage detector has a real 3-hop negative cycle to find.
 *
 * The two "real" genesis pools (EQU-WBTC, EQU-USDC) only ever touch EQU, so
 * they can never form a triangle by themselves — you need a third pool that
 * connects WBTC and USDC directly, priced away from the rate implied by the
 * other two, to create an actual arbitrage opportunity.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run seed-arbitrage-demo
 *   pnpm --filter @workspace/scripts run seed-arbitrage-demo -- --url http://localhost:8080
 *
 * Safe to re-run: the API rejects a duplicate pool id with 409, which this
 * script treats as a no-op success. The API itself refuses to seed when
 * NODE_ENV=production.
 */

const args = process.argv.slice(2);
const urlFlagIndex = args.indexOf("--url");
const baseUrl = urlFlagIndex !== -1 && args[urlFlagIndex + 1]
  ? args[urlFlagIndex + 1]!
  : (process.env["API_BASE_URL"] ?? "http://localhost:8080");

async function main(): Promise<void> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/dex/pools/seed-arbitrage-demo`;
  console.log(`Seeding arbitrage demo pool via ${endpoint} ...`);

  const res = await fetch(endpoint, { method: "POST" });
  const body = await res.json().catch(() => ({}));

  if (res.status === 409) {
    console.log("Demo pool already exists — nothing to do.", body);
    return;
  }
  if (!res.ok) {
    console.error(`Seed request failed (${res.status}):`, body);
    process.exitCode = 1;
    return;
  }

  console.log("Seeded successfully:", body);
  console.log(
    "\nNext: open the Dex page in the Explorer (or GET /api/arbitrage/opportunities) " +
    "to see the detected cycle: EQU -> WBTC -> USDC -> EQU (or its reverse).",
  );
}

main().catch(err => {
  console.error("Failed to seed arbitrage demo pool:", err);
  process.exitCode = 1;
});
