/**
 * Vitest global setup for VIA SaaS (M1.8).
 *
 * Creates/recreates a DISPOSABLE test database and applies the Prisma
 * migration history to it. The development database (via_saas_db) is never
 * touched: tests always run against via_saas_test.
 *
 * Locally the database is recreated through `docker exec` into the running
 * postgres:15 container. In CI (fresh service container) the database is
 * already empty, so only migrations are applied.
 */
import { execSync } from "node:child_process"
import path from "node:path"

export const TEST_DB_NAME = "via_saas_test"

export function resolveTestDatabaseUrl(): string {
  return (
    process.env.TEST_DATABASE_URL ??
    `postgresql://postgres:postgres@localhost:5430/${TEST_DB_NAME}?schema=public`
  )
}

export default function globalSetup() {
  const databaseUrl = resolveTestDatabaseUrl()
  const isCi = !!process.env.CI

  if (!isCi) {
    const recreate = `docker exec -i via_saas_db psql -U postgres -c "DROP DATABASE IF EXISTS ${TEST_DB_NAME}" -c "CREATE DATABASE ${TEST_DB_NAME}"`
    execSync(recreate, { stdio: "pipe" })
  }

  const projectRoot = path.resolve(__dirname, "..")
  execSync("npx prisma migrate deploy", {
    cwd: path.join(projectRoot, "packages", "database"),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  })

  // Workers receive the same URL via vitest.config `test.env`.
  process.env.DATABASE_URL = databaseUrl
}
