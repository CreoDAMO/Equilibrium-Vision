import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // The source files use ".js" extensions for node16 module resolution.
      // Strip the extension so Vitest's TypeScript transform can find the ".ts" file.
      { find: /^(\..+)\.js$/, replacement: "$1" },
    ],
  },
  test: {
    environment: "node",
    // Chain-advancing integration tests intentionally mine 100+ blocks to
    // cross challenge/finality windows. On GitHub runners this can take about
    // a minute, so the default 20-second timeout causes false CI failures.
    //
    // The arbitrage stress suite calls setupVerifiedModel() per test which mines
    // ~103 blocks synchronously — on slow CI runners each test can exceed 2 min.
    // 300 s (5 min) gives ample headroom without masking genuine hangs.
    testTimeout: 300_000,
    include: ["src/**/*.test.ts"],
    pool: "forks",
    forks: { singleFork: true },
    env: {
      DATABASE_URL: "postgresql://runner@127.0.0.1:5432/equilibrium",
      NODE_ENV: "test",
    },
    coverage: {
      provider: "v8",
      include: ["src/chain/**"],
      reporter: ["text", "lcov"],
    },
  },
});
