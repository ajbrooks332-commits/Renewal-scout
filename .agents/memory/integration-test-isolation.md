---
name: Integration test isolation — TEST_DATABASE_URL
description: schema.integration.test.ts requires TEST_DATABASE_URL, refuses if equals DATABASE_URL, needs ALLOW_DESTRUCTIVE_DB_TESTS=true.
---

# Integration test isolation

`artifacts/api-server/tests/schema.integration.test.ts` requires:
1. `TEST_DATABASE_URL` env var set
2. `TEST_DATABASE_URL !== DATABASE_URL` (fail with clear message if equal)
3. `ALLOW_DESTRUCTIVE_DB_TESTS=true`

A dedicated `testPool = new Pool({ connectionString: TEST_DATABASE_URL })` is created in `beforeAll` and used for ALL raw SQL in the file. The `pool` from `@workspace/db` is not used for raw SQL (it uses DATABASE_URL which must not be touched).

`runMigrations()` still uses `@workspace/db`'s pool (DATABASE_URL). In CI, set `DATABASE_URL=TEST_DATABASE_URL` for the integration test job, or run `test:integration` in an environment where DATABASE_URL already points to the test database.

**Why:** Previous version ran directly against DATABASE_URL and could corrupt production data.
