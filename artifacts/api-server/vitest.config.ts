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
    testTimeout: 20_000,
    include: ["src/**/*.test.ts"],
    pool: "forks",
    forks: { singleFork: true },
    env: {
      DATABASE_URL: "postgresql://runner@127.0.0.1:5432/equilibrium",
    },
    coverage: {
      provider: "v8",
      include: ["src/chain/**"],
      reporter: ["text", "lcov"],
    },
  },
});
