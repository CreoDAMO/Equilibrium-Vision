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
 *   pnpm --filter @workspace/scripts run seed-arbitrage-demo -- --discount-bp 500 --pool-id WBTC-USDC-2
 *
 * Flags (all optional):
 *   --pool-id <id>        pool id to create (default "WBTC-USDC")
 *   --discount-bp <n>     how far below the 100,000-fair price to seed, in
 *                         basis points (default 2000 = 20% cheap). Lower
 *                         values produce a smaller/marginal cycle; values
 *                         near 9000+ produce a huge one, useful for exercising
 *                         the arbitrageMaxTradeAmount hard cap.
 *   --reserve-a <n>       manual WBTC reserve (overrides --discount-bp math)
 *   --reserve-b <n>       manual USDC reserve (overrides --discount-bp math)
 *
 * Safe to re-run: the API rejects a duplicate pool id with 409, which this
 * script treats as a no-op success. The API itself refuses to seed when
 * NODE_ENV=production.
 */

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}
const baseUrl = flag("--url") ?? (process.env["API_BASE_URL"] ?? "http://localhost:8080");
const poolId = flag("--pool-id");
const discountBp = flag("--discount-bp");
const reserveA = flag("--reserve-a");
const reserveB = flag("--reserve-b");

async function main(): Promise<void> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/dex/pools/seed-arbitrage-demo`;
  console.log(`Seeding arbitrage demo pool via ${endpoint} ...`);

  const payload: Record<string, string | number> = {};
  if (poolId) payload["poolId"] = poolId;
  if (discountBp) payload["discountBp"] = Number(discountBp);
  if (reserveA) payload["reserveA"] = Number(reserveA);
  if (reserveB) payload["reserveB"] = Number(reserveB);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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
