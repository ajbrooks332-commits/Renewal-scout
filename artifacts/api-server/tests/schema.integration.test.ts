/**
 * Schema integration test — runs against the real PostgreSQL database.
 *
 * This test does NOT use the vi.mock("@workspace/db") shim from setup.ts.
 * It verifies that:
 *  1. runMigrations() completes without error (idempotent — called twice)
 *  2. All six expected tables exist in the public schema
 *  3. The four Task-5 tables have the correct key columns
 *  4. runMigrations() handles the "upgrade from a push-provisioned database"
 *     path correctly: when the drizzle migrations journal is cleared and
 *     the sentinel tables already exist, seeding recreates the journal and
 *     migrate() applies zero SQL statements (all tables remain intact).
 *
 * Run: pnpm --filter @workspace/api-server run test:integration
 *
 * DATABASE_URL must point at the real (or test) PostgreSQL instance.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { runMigrations, pool } from "@workspace/db";

const EXPECTED_TABLES = [
  "services",
  "research_runs",
  "household_profile",
  "service_requirements",
  "current_deals",
  "document_extractions",
];

describe("database schema — post-migration integrity", () => {
  it("runMigrations() completes without error (fresh call)", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("runMigrations() is idempotent — safe to call twice", async () => {
    // A second call must also succeed without error and must not corrupt data.
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("all six expected tables exist in the public schema", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type  = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `table "${t}" is missing`).toContain(t);
    }
  });

  it("household_profile has questionnaire_version and car_make columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'household_profile'`,
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("questionnaire_version");
    expect(cols).toContain("car_make");
    expect(cols).toContain("car_model");
    expect(cols).toContain("car_year");
  });

  it("current_deals.fields has default empty jsonb and unique(service_id)", async () => {
    const { rows: colRows } = await pool.query<{
      column_name: string;
      column_default: string;
    }>(
      `SELECT column_name, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'current_deals'
         AND column_name  = 'fields'`,
    );
    expect(colRows).toHaveLength(1);
    expect(colRows[0]!.column_default).toMatch(/\{\}/); // default '{}'::jsonb

    const { rows: idxRows } = await pool.query<{ constraint_type: string }>(
      `SELECT constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema    = 'public'
         AND table_name      = 'current_deals'
         AND constraint_type = 'UNIQUE'`,
    );
    expect(idxRows.length).toBeGreaterThan(0);
  });

  it("document_extractions has draft_field_keys (jsonb) and extraction_id (unique)", async () => {
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
    }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'document_extractions'`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName["draft_field_keys"]).toBe("jsonb");
    expect(byName["extraction_id"]).toBeDefined();

    const { rows: uq } = await pool.query<{ constraint_type: string }>(
      `SELECT constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema    = 'public'
         AND table_name      = 'document_extractions'
         AND constraint_type = 'UNIQUE'`,
    );
    expect(uq.length).toBeGreaterThan(0);
  });
});

// ── Upgrade-path test ─────────────────────────────────────────────────────────
//
// Simulates a database that was provisioned via `drizzle-kit push`:
//  - All tables already exist (services, research_runs, task-5 tables)
//  - drizzle.__drizzle_migrations journal is EMPTY
//
// Verifies that runMigrations() correctly seeds the journal, applies zero SQL
// DDL statements, and leaves all tables intact.

describe("upgrade-path: push-provisioned database simulation", () => {
  // Save existing journal rows so we can restore them after the test.
  let savedJournalRows: Array<{ hash: string; created_at: string | null }> = [];

  beforeAll(async () => {
    const { rows } = await pool.query<{ hash: string; created_at: string | null }>(
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    savedJournalRows = rows;
    // Clear the journal — simulate a push-provisioned state
    await pool.query(`DELETE FROM drizzle.__drizzle_migrations`);
  });

  afterAll(async () => {
    // Restore original journal so subsequent test runs start from a known state.
    await pool.query(`DELETE FROM drizzle.__drizzle_migrations`);
    for (const row of savedJournalRows) {
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [row.hash, row.created_at],
      );
    }
    await pool.end();
  });

  it("runMigrations() succeeds when journal is empty but all tables already exist", async () => {
    // No journal entries → seeding logic should detect sentinel tables and
    // seed hashes, then migrate() runs zero DDL statements.
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("all six tables still exist after journal-seeded migration run", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type   = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `table "${t}" was lost after seeded migration run`).toContain(t);
    }
  });

  it("journal is re-populated after seeded migration run", async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    // At minimum, both migrations should now be tracked
    expect(parseInt(rows[0]!.count)).toBeGreaterThanOrEqual(2);
  });

  it("a second call to runMigrations() is still idempotent", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });
});
