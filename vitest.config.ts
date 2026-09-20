import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Real-subprocess and integration suites drive a real Python venv.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
