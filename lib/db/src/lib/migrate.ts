/**
 * Programmatic migration runner.
 *
 * Import and call runMigrations() at server startup (before accepting requests)
 * so every deployment automatically applies any outstanding schema changes.
 *
 * ── Migration layout ───────────────────────────────────────────────────────
 *  0000  – Baseline: services + research_runs (pre-Task-5 schema)
 *  0001  – Task 5 additions: household_profile, service_requirements,
 *           current_deals, document_extractions
 *  0002  – Reconciliation: pence columns, DB constraints, push-provisioned
 *           database upgrade path
 *
 * ── Push-provisioned databases ────────────────────────────────────────────
 * Databases previously provisioned via `drizzle-kit push` have no Drizzle
 * migrations journal.  Migration 0002 handles the upgrade path safely using
 * conditional DDL (IF NOT EXISTS / DO $$ ... EXCEPTION blocks), so Drizzle's
 * standard migrate() can run all three migrations without errors regardless
 * of the prior database state.
 */

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "url";
import path from "path";
import { db, pool } from "./connection";

// ── Migrations folder path ────────────────────────────────────────────────────
//
// In development (ts-node / tsx / Vitest):
//   import.meta.url  → file:///…/lib/db/src/lib/migrate.ts
//   "../../drizzle"  → lib/db/drizzle/  ✓
//
// In production (esbuild bundle at dist/index.mjs):
//   import.meta.url  → file:///…/artifacts/api-server/dist/index.mjs
//   "drizzle"        → artifacts/api-server/dist/drizzle/  ✓ (copied by build.mjs)

const __filedir = fileURLToPath(new URL(".", import.meta.url));
const isBundled = !__filedir.includes(`${path.sep}src${path.sep}`);
export const migrationsFolder = isBundled
  ? path.resolve(__filedir, "drizzle")
  : path.resolve(__filedir, "../../drizzle");

/**
 * Apply all outstanding migrations and return.
 *
 * Uses Drizzle's built-in journal so only un-applied migrations are executed.
 * Safe to call on every startup — already-applied migrations are skipped.
 * Throws if the database is unavailable or a migration fails (fail-closed).
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder });
}
