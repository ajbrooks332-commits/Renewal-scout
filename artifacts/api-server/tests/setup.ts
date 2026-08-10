import { vi } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
// Must be defined before any module that imports it is loaded.

vi.mock("@workspace/db", () => {
  /**
   * Build a chainable query builder mock that resolves to `finalValue` when
   * awaited. Every method returns the same chain so callers can chain
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
    pool: {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn(),
    },
    db: {
      select: vi.fn(() => makeChain([])),
      update: vi.fn(() => makeChain([])),
      insert: vi.fn(() => makeChain([])),
    },
    servicesTable: {},
    researchRunsTable: {},
  };
});

// ─── Set test environment ─────────────────────────────────────────────────────
process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = "test-secret-that-is-long-enough-for-tests";
process.env["ADMIN_PASSWORD"] = "test-admin-password";
process.env["DATABASE_URL"] = "postgresql://test:test@localhost/test";
