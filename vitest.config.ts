import { defineConfig } from "vitest/config"

// M1 test harness configuration.
// Tests run against a DISPOSABLE Postgres database (never the dev data):
// 1. tests/global-setup.ts recreates the database and applies migrations.
// 2. Workers receive DATABASE_URL through `test.env` below.
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: "./tests/global-setup.ts",
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "postgresql://postgres:postgres@localhost:5430/via_saas_test?schema=public",
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: true,
    include: ["tests/**/*.test.ts"],
  },
})
