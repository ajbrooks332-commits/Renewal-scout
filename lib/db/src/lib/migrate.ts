/**
 * Programmatic migration runner.
 *
 * Import and call runMigrations() at server startup (before accepting requests)
 * so every deployment automatically applies any outstanding schema changes.
 *
 * ── Why journal seeding? ────────────────────────────────────────────────────
 * When `drizzle-kit push` was used to provision the schema (rather than the
 * migrate command), the `drizzle.__drizzle_migrations` journal table does not
 * exist.  Without seeding, Drizzle would re-run every migration on the first
 * startup after migrations are introduced, attempting to CREATE TABLE for
 * tables that already exist.
 *
 * Although all CREATE TABLE statements in our migrations use IF NOT EXISTS (and
 * FK constraints are wrapped in BEGIN … EXCEPTION handlers), Drizzle still
 * marks each migration as "applied" after running it, which is correct
 * behaviour.  The seeding step is an additional safety layer: it explicitly
 * marks a migration as applied when its sentinel table already exists, so
 * Drizzle never even tries to re-execute it.
 *
 * ── Migration layout ───────────────────────────────────────────────────────
 *  0000  – Baseline: services + research_runs (pre-Task-5 schema)
 *  0001  – Task 5 additions: household_profile, service_requirements,
 *           current_deals, document_extractions
 */

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
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

// ── Sentinel tables that indicate each migration has already been applied ─────
// Used only when the migrations journal is absent (push-provisioned databases).

const MIGRATION_SENTINELS: Record<string, string> = {
  // journal tag → a table that definitively proves this migration was applied
  "0000_wealthy_colonel_america": "services",
  "0001_task5_household_deals": "household_profile",
};

/**
 * Ensure the Drizzle migrations journal is seeded for databases that were
 * provisioned via `drizzle-kit push` (which does not write to the journal).
 *
 * Algorithm:
 *  1. Create drizzle.__drizzle_migrations if it does not exist.
 *  2. For each migration in the journal that has no matching hash entry:
 *     a. If the sentinel table for that migration already exists in pg_tables,
 *        the migration was applied via push — insert its hash so Drizzle skips it.
 *  3. Call migrate() — it will only apply migrations whose hash is NOT in the
 *     journal, meaning only genuinely un-applied migrations are executed.
 */
async function seedJournalForPushProvisioned(): Promise<void> {
  // Ensure the drizzle schema and tracking table exist.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id   SERIAL PRIMARY KEY,
      hash text   NOT NULL,
      created_at bigint
    )
  `);

  // Load the current journal entries that are already recorded as applied.
  const { rows: appliedRows } = await pool.query<{ hash: string }>(
    `SELECT hash FROM drizzle.__drizzle_migrations`,
  );
  const appliedHashes = new Set(appliedRows.map((r) => r.hash));

  // Check which sentinel tables already exist in the database.
  const sentinelNames = Object.values(MIGRATION_SENTINELS);
  const { rows: existingTables } = await pool.query<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1)`,
    [sentinelNames],
  );
  const existingTableNames = new Set(existingTables.map((r) => r.table_name));

  // For each migration, if its sentinel table exists but its hash is not yet
  // in the journal, seed the hash so Drizzle treats it as applied.
  const migrations = readMigrationFiles({ migrationsFolder });
  const sentinelTags = Object.keys(MIGRATION_SENTINELS);
  for (let i = 0; i < migrations.length; i++) {
    const m = migrations[i]!;
    if (appliedHashes.has(m.hash)) continue; // already tracked

    const migTag = sentinelTags[i];
    const sentinel = migTag ? MIGRATION_SENTINELS[migTag] : undefined;

    if (sentinel && existingTableNames.has(sentinel)) {
      // The sentinel table exists → the migration was applied via push.
      // Seed the hash into the journal so Drizzle will skip it.
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1
         )`,
        [m.hash, m.folderMillis],
      );
    }
  }
}

export async function runMigrations(): Promise<void> {
  await seedJournalForPushProvisioned();
  await migrate(db, { migrationsFolder });
}
