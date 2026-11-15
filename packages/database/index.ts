// packages/database/index.ts
//
// Single source of PrismaClient for the whole workspace.
// DATABASE_URL is read from the environment ONLY — never hardcoded.
// - Next.js (merchant-dashboard) loads its own .env automatically.
// - Plain Node processes (apps/api, scripts, tests) fall back to loading
//   the .env file in the current working directory (Node >= 20.12).
// - If DATABASE_URL is still missing, startup fails fast with a clear error.
import { PrismaClient } from '@prisma/client'

function ensureDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL

  // Loads .env from the process working directory (no dependency required).
  // Throws if no .env file exists — swallowed; validation below handles it.
  try {
    process.loadEnvFile()
  } catch {
    // no .env file in CWD
  }

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Provide it via the environment or a .env file (see .env.example). Never hardcode credentials in source."
    )
  }
  return process.env.DATABASE_URL
}

const databaseUrl = ensureDatabaseUrl()

const globalForPrisma = global as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Full query logging is a local-dev aid only; never emit query logs in
    // production or tests (they can contain user data).
    log: process.env.NODE_ENV === 'production' || process.env.VITEST ? ['error'] : ['query'],
    datasources: {
      db: { url: databaseUrl },
    },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
