/**
 * Schema integration test — runs against a TEST PostgreSQL database.
 *
 * Safety guards (enforced in the top-level beforeAll):
 *   1. TEST_DATABASE_URL must be set.
 *   2. TEST_DATABASE_URL must differ from DATABASE_URL so production data
 *      cannot be touched by this test suite.
 *   3. ALLOW_DESTRUCTIVE_DB_TESTS=true must be set (explicit opt-in).
 *
 * A dedicated pg.Pool is created from TEST_DATABASE_URL and used for all
 * raw SQL queries so this file NEVER touches the application database
 * (connected via DATABASE_URL / the @workspace/db exported pool).
 *
 * Verifies:
 *  1. runMigrations() completes without error and is idempotent
 *  2. All six expected tables exist after migrations
 *  3. Key columns and constraints are present
 *  4. New constraints added in 0002 are enforced:
 *     - research_runs.status CHECK (queued/running/complete/failed)
 *     - household_profile singleton CHECK (id = 1)
 *     - Partial UNIQUE index for active research runs
 *     - monetary columns stored as integer pence
 *  5. The push-provisioned upgrade path works: clearing the journal and
 *     re-running migrations produces a clean, constrained schema.
 *
 * Run: pnpm --filter @workspace/api-server run test:integration
 *
 * DATABASE_URL must point at the application PostgreSQL instance.
 * TEST_DATABASE_URL must point at a SEPARATE, disposable test database.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Pool } from "pg";
import { runMigrations } from "@workspace/db";

const EXPECTED_TABLES = [
  "services",
  "research_runs",
  "household_profile",
  "service_requirements",
  "current_deals",
  "document_extractions",
];

// ── Test database pool — initialised in top-level beforeAll ────────────────────
// All raw SQL in this file uses testPool, NOT the @workspace/db pool, so the
// application database is never touched.
let testPool: Pool;

// ── Safety guards ─────────────────────────────────────────────────────────────
beforeAll(async () => {
  const testUrl = process.env["TEST_DATABASE_URL"];
  const appUrl  = process.env["DATABASE_URL"];
  const permit  = process.env["ALLOW_DESTRUCTIVE_DB_TESTS"];

  if (!testUrl) {
    throw new Error(
      "Integration tests require TEST_DATABASE_URL to be set. " +
      "Point it at a disposable test database that is SEPARATE from DATABASE_URL.",
    );
  }

  if (testUrl === appUrl) {
    throw new Error(
      "TEST_DATABASE_URL must differ from DATABASE_URL. " +
      "The integration test suite clears migration journals and inserts/deletes rows — " +
      "running it against the application database would corrupt live data.",
    );
  }

  if (permit !== "true") {
    throw new Error(
      "Set ALLOW_DESTRUCTIVE_DB_TESTS=true to confirm you understand this suite " +
      "modifies the TEST_DATABASE_URL database. It must not point at production.",
    );
  }

  // Create a dedicated pool for the test database.
  testPool = new Pool({ connectionString: testUrl });

  // Warm up the pool and verify connectivity before any test runs.
  await testPool.query("SELECT 1");
});

// ── Basic migration integrity ─────────────────────────────────────────────────

describe("database schema — post-migration integrity", () => {
  it("runMigrations() completes without error (fresh call)", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("runMigrations() is idempotent — safe to call twice", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("all six expected tables exist in the public schema", async () => {
    const { rows } = await testPool.query<{ table_name: string }>(
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
    const { rows } = await testPool.query<{ column_name: string }>(
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

  it("services table has integer pence columns (not real GBP)", async () => {
    const { rows } = await testPool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'services'
         AND column_name  IN ('monthly_cost_pence', 'annual_cost_pence',
                              'monthly_cost_gbp', 'annual_cost_gbp')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    // Pence columns must exist as integers
    expect(byName["monthly_cost_pence"]).toBe("integer");
    expect(byName["annual_cost_pence"]).toBe("integer");
    // Old GBP real columns must not exist
    expect(byName["monthly_cost_gbp"]).toBeUndefined();
    expect(byName["annual_cost_gbp"]).toBeUndefined();
  });

  it("household_profile has integer pence car_value column", async () => {
    const { rows } = await testPool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = 'household_profile'
         AND column_name  IN ('car_value_pence', 'car_value_gbp')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName["car_value_pence"]).toBe("integer");
    expect(byName["car_value_gbp"]).toBeUndefined();
  });

  it("current_deals.fields has default empty jsonb and unique(service_id)", async () => {
    const { rows: colRows } = await testPool.query<{
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
    expect(colRows[0]!.column_default).toMatch(/\{\}/);

    const { rows: idxRows } = await testPool.query<{ constraint_type: string }>(
      `SELECT constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema    = 'public'
         AND table_name      = 'current_deals'
         AND constraint_type = 'UNIQUE'`,
    );
    expect(idxRows.length).toBeGreaterThan(0);
  });

  it("document_extractions has draft_field_keys (jsonb) and extraction_id (unique)", async () => {
    const { rows } = await testPool.query<{
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

    const { rows: uq } = await testPool.query<{ constraint_type: string }>(
      `SELECT constraint_type
       FROM information_schema.table_constraints
       WHERE table_schema    = 'public'
         AND table_name      = 'document_extractions'
         AND constraint_type = 'UNIQUE'`,
    );
    expect(uq.length).toBeGreaterThan(0);
  });
});

// ── Constraint enforcement tests ──────────────────────────────────────────────

describe("database constraints — enforced at DB level", () => {
  afterAll(async () => {
    // Clean up any test rows we inserted
    await testPool.query(`DELETE FROM services WHERE provider LIKE 'ConstraintTest%'`).catch(() => {});
    await testPool.query(`DELETE FROM household_profile WHERE id != 1`).catch(() => {});
  });

  it("research_runs.status CHECK rejects invalid status values", async () => {
    // Insert a service first so we have a valid service_id
    const { rows: svcRows } = await testPool.query<{ id: number }>(
      `INSERT INTO services (provider, service_type) VALUES ('ConstraintTest-Status', 'Broadband') RETURNING id`,
    );
    const serviceId = svcRows[0]!.id;

    await expect(
      testPool.query(
        `INSERT INTO research_runs (service_id, status) VALUES ($1, 'invalid_status')`,
        [serviceId],
      ),
    ).rejects.toThrow();

    // Clean up
    await testPool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
  });

  it("research_runs.status CHECK accepts valid status values", async () => {
    // Use a separate service per status so the partial UNIQUE index
    // (one active run per service) is not triggered.
    for (const status of ["queued", "running", "complete", "failed"]) {
      const { rows: svcRows } = await testPool.query<{ id: number }>(
        `INSERT INTO services (provider, service_type) VALUES ($1, 'Broadband') RETURNING id`,
        [`ConstraintTest-ValidStatus-${status}`],
      );
      const serviceId = svcRows[0]!.id;

      const { rows } = await testPool.query<{ id: number }>(
        `INSERT INTO research_runs (service_id, status) VALUES ($1, $2) RETURNING id`,
        [serviceId, status],
      );
      expect(rows[0]!.id).toBeGreaterThan(0);

      // Clean up immediately (cascade deletes research_runs too)
      await testPool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
    }
  });

  it("partial UNIQUE index prevents duplicate active (queued/running) runs per service", async () => {
    const { rows: svcRows } = await testPool.query<{ id: number }>(
      `INSERT INTO services (provider, service_type) VALUES ('ConstraintTest-Dup', 'Energy') RETURNING id`,
    );
    const serviceId = svcRows[0]!.id;

    // First queued run should succeed
    await testPool.query(
      `INSERT INTO research_runs (service_id, status) VALUES ($1, 'queued')`,
      [serviceId],
    );

    // Second queued run for same service should violate the partial unique index
    await expect(
      testPool.query(
        `INSERT INTO research_runs (service_id, status) VALUES ($1, 'queued')`,
        [serviceId],
      ),
    ).rejects.toThrow();

    // A 'complete' run for the same service IS allowed (not in the partial index)
    await expect(
      testPool.query(
        `INSERT INTO research_runs (service_id, status) VALUES ($1, 'complete')`,
        [serviceId],
      ),
    ).resolves.not.toThrow();

    // Clean up
    await testPool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
  });

  it("household_profile singleton CHECK rejects id != 1", async () => {
    await expect(
      testPool.query(
        `INSERT INTO household_profile (id) VALUES (2)`,
      ),
    ).rejects.toThrow();
  });

  it("services non-negative CHECK rejects negative pence values", async () => {
    await expect(
      testPool.query(
        `INSERT INTO services (provider, service_type, monthly_cost_pence)
         VALUES ('ConstraintTest-NegCost', 'Broadband', -1)`,
      ),
    ).rejects.toThrow();
  });

  it("pence round-trip: 45.99 GBP → 4599 pence stored and returned correctly", async () => {
    const { rows: svcRows } = await testPool.query<{
      id: number;
      monthly_cost_pence: number;
      annual_cost_pence: number;
    }>(
      `INSERT INTO services (provider, service_type, monthly_cost_pence, annual_cost_pence)
       VALUES ('ConstraintTest-Pence', 'Broadband', 4599, 54000)
       RETURNING id, monthly_cost_pence, annual_cost_pence`,
    );
    expect(svcRows[0]!.monthly_cost_pence).toBe(4599);
    expect(svcRows[0]!.annual_cost_pence).toBe(54000);

    // Clean up
    await testPool.query(`DELETE FROM services WHERE id = $1`, [svcRows[0]!.id]);
  });
});

// ── Upgrade-path test ─────────────────────────────────────────────────────────
//
// Simulates a database that was provisioned via `drizzle-kit push`:
//  - All tables already exist (services, research_runs, task-5 tables)
//  - drizzle.__drizzle_migrations journal is EMPTY
//
// Since migrations 0000 and 0001 use IF NOT EXISTS / EXCEPTION guards,
// and migration 0002 uses conditional DDL throughout, runMigrations() should
// succeed and leave all tables intact.

describe("upgrade-path: push-provisioned database simulation", () => {
  let savedJournalRows: Array<{ hash: string; created_at: string | null }> = [];

  beforeAll(async () => {
    const { rows } = await testPool.query<{ hash: string; created_at: string | null }>(
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
    );
    savedJournalRows = rows;
    // Clear the journal — simulate a push-provisioned state
    await testPool.query(`DELETE FROM drizzle.__drizzle_migrations`);
  });

  afterAll(async () => {
    // Restore original journal so subsequent test runs start from a known state.
    await testPool.query(`DELETE FROM drizzle.__drizzle_migrations`);
    for (const row of savedJournalRows) {
      await testPool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [row.hash, row.created_at],
      );
    }
    await testPool.end();
  });

  it("runMigrations() succeeds when journal is empty but all tables already exist", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("all six tables still exist after journal-cleared migration run", async () => {
    const { rows } = await testPool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type   = 'BASE TABLE'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `table "${t}" was lost after migration run`).toContain(t);
    }
  });

  it("journal has at least three entries after re-run (0000, 0001, 0002)", async () => {
    const { rows } = await testPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );
    expect(parseInt(rows[0]!.count)).toBeGreaterThanOrEqual(3);
  });

  it("constraints are present and enforced after upgrade path", async () => {
    // Status CHECK still works after upgrade-path migration
    const { rows: svcRows } = await testPool.query<{ id: number }>(
      `INSERT INTO services (provider, service_type) VALUES ('UpgradeTest-Constraint', 'Energy') RETURNING id`,
    );
    const serviceId = svcRows[0]!.id;

    await expect(
      testPool.query(
        `INSERT INTO research_runs (service_id, status) VALUES ($1, 'bad_status')`,
        [serviceId],
      ),
    ).rejects.toThrow();

    await testPool.query(`DELETE FROM services WHERE id = $1`, [serviceId]);
  });

  it("a second call to runMigrations() is still idempotent", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });
});
