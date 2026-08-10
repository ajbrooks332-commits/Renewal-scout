/**
 * Vitest config for integration tests that run against the real PostgreSQL
 * database (DATABASE_URL must be set and the DB must be reachable).
 *
 * These tests do NOT use the DB mock from tests/setup.ts.
 * Run with: pnpm --filter @workspace/api-server run test:integration
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Intentionally no setupFiles — we want the real @workspace/db pool/db.
    setupFiles: [],
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 30_000, // DB round-trips can be slow on cold start
  },
});
