import { vi } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
// Must be defined before any module that imports it is loaded.
//
// We use importOriginal so that real table definitions (servicesTable,
// currentDealsTable, etc.) are kept intact. Drizzle's `eq()` and other SQL
// helpers require real column objects — mocking the tables as `{}` causes
// runtime errors when routes call eq(someTable.id, value).
// We only replace `db` and `pool` with vi.fn() mocks.

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();

  /**
   * Build a chainable query builder mock that resolves to `finalValue` when
   * awaited. Every builder method (from, where, orderBy, set, values,
   * onConflictDoNothing) returns the same chain so callers can chain
   * .from().where().orderBy().limit() etc. freely.
   */
  const makeChain = (finalValue: unknown = []) => {
    const resolved = Promise.resolve(finalValue);
    const chain: Record<string, unknown> = {
      // Return self for every builder method
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      set: () => chain,
      values: () => chain,
      onConflictDoNothing: () => chain,
      onConflictDoUpdate: () => chain,
      // Terminal methods that return a real Promise
      limit: () => resolved,
      returning: () => resolved,
      // Make the chain itself awaitable — resolves to finalValue
      then: (
        onfulfilled?: ((value: unknown) => unknown) | null,
        onrejected?: ((reason: unknown) => unknown) | null,
      ) => resolved.then(onfulfilled, onrejected),
      catch: (onrejected?: ((reason: unknown) => unknown) | null) =>
        resolved.catch(onrejected),
      finally: (onfinally?: (() => void) | null) => resolved.finally(onfinally),
    };
    return chain as ReturnType<typeof import("@workspace/db").db.select>;
  };

  return {
    // Keep real table definitions so Drizzle helpers (eq, etc.) work correctly
    ...actual,
    // Replace pool and db with mocks
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
    },
    db: {
      select: vi.fn(() => makeChain([])),
      update: vi.fn(() => makeChain([])),
      insert: vi.fn(() => makeChain([])),
    },
  };
});

// ─── Set test environment ─────────────────────────────────────────────────────
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "test-secret-that-is-long-enough-for-tests";
process.env["ADMIN_PASSWORD"] = "test-admin-password";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
