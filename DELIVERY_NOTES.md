# Renewal Scout — Delivery Notes

## Overview

This document covers changes made across Task #13 (OpenAI Research Hardening & PG Worker Queue), Task #14 (Express Security Hardening & Frontend Fixes), and Task #15 (Tests, Source Export & Verified Delivery) for the Renewal Scout project.

---

## Verification Results

All five checks pass on the delivered codebase:

| Command | Result |
|---|---|
| `pnpm install` | ✅ Exit 0 — no missing dependencies |
| `pnpm run typecheck` | ✅ Exit 0 — 4 packages typecheck clean |
| `pnpm --filter @workspace/api-server run test` | ✅ Exit 0 — **243 unit tests pass** |
| `pnpm --filter @workspace/api-server run test:integration` | ✅ Exit 0 — **19 integration tests pass** |
| `pnpm run build` | ✅ Exit 0 — all packages build (api-server, renewal-scout, mockup-sandbox) |

---

## Changed Files

### New Files

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/research-service-schema.ts` | Zod schema (`DealReportSchema`) for runtime AI response validation |
| `artifacts/api-server/src/lib/worker.ts` | PG-backed worker: poll loop, reentrancy guard, atomic job claim |
| `artifacts/api-server/src/lib/stale-jobs.ts` | Stale-job recovery via heartbeat staleness detection |
| `artifacts/api-server/tests/task13.test.ts` | 56 unit tests: allowlists, `computeSavings`, citations, deny-by-default |
| `lib/db/drizzle/0006_research_runs_worker_queue.sql` | Migration: 5 worker-queue columns on `research_runs` |
| `DELIVERY_NOTES.md` | This file |

### Modified Files

| File | Summary of changes |
|---|---|
| `artifacts/api-server/src/lib/research-service.ts` | Model env var, `filterProfileForService` deny-by-default, `computeSavings`, citation reconciliation, `store:false`, mandatory warnings, heartbeat try/finally |
| `artifacts/api-server/src/lib/scheduler.ts` | Fail-closed on invalid config; `scanDueServices` queues only (no direct dispatch) |
| `artifacts/api-server/src/app.ts` | Helmet + explicit CSP, CORS fix (dev: `cb(null,false)` for unknown origins), global error handler strips internals |
| `artifacts/api-server/src/index.ts` | Production startup fails if `ADMIN_PASSWORD` or `APP_BASE_URL` (HTTPS) absent |
| `artifacts/api-server/src/routes/auth.ts` | `setupWarnings` returned only for authenticated sessions |
| `artifacts/api-server/src/routes/services.ts` | Removed direct `executeResearch` call; worker owns all dispatch |
| `artifacts/api-server/tests/app.test.ts` | Post-auth warning gate tests; replaced fake 42===42 structural guard with real `queueResearch` invocation |
| `artifacts/api-server/tests/unit.test.ts` | `queueResearch` idempotency, new-run, DB conflict, service-not-found tests |
| `artifacts/renewal-scout/src/pages/service-detail.tsx` | "Delete" → "Archive" throughout; polling `useEffect` for queued/running runs |
| `artifacts/renewal-scout/src/pages/current-deal-tab.tsx` | ManualDealEditor: initialises from confirmed-extracted values; touched-field tracking; number parsing |
| `artifacts/renewal-scout/vite.config.ts` | PORT/BASE\_PATH no longer throw in build mode (safe fallback for CI) |
| `artifacts/mockup-sandbox/vite.config.ts` | Same PORT/BASE\_PATH build-mode fix |
| `lib/db/drizzle/0004_research_runs_generic_mode.sql` | Added `IF NOT EXISTS` guard (was plain ALTER TABLE; caused upgrade-path integration test failures) |
| `lib/db/drizzle/meta/_journal.json` | Added entry for migration 0006 |

---

## Migration Notes

### Applying to a fresh database

Run all migrations in order (0000 → 0006). All migrations are idempotent — safe to run twice.

```bash
DATABASE_URL=postgres://... pnpm --filter @workspace/db run migrate
```

### Applying to an existing production database

1. **Back up the database** before running.
2. Migrations 0004–0006 are all conditional (`DO $$ IF NOT EXISTS ... $$`), so they are safe to run on databases already provisioned via `drizzle-kit push`.
3. Migration 0006 adds 5 new nullable/defaulted columns to `research_runs`. Existing rows will have `retry_count = 0`, `max_retries = 2`, and all timestamp columns `NULL`. The worker treats `NULL` heartbeat as "not running" — correct for existing rows.

### Rolling back

There are no automated rollback scripts. If you need to revert migration 0006:

```sql
ALTER TABLE research_runs
  DROP COLUMN IF EXISTS queued_at,
  DROP COLUMN IF EXISTS claimed_at,
  DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS retry_count,
  DROP COLUMN IF EXISTS max_retries;
```

Also remove the 0006 entry from the `drizzle_migrations` table.

---

## Environment Variables

### Required in production

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET` | Min 32 chars; startup exits if absent |
| `ADMIN_PASSWORD` | Dashboard access; startup exits if absent |
| `APP_BASE_URL` | Must be HTTPS; startup exits if absent or non-HTTPS |
| `OPENAI_API_KEY` | Responses API key |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_MODEL` | `gpt-5.6-terra` | Responses API model |
| `SCHEDULER_ENABLED` | `false` | Only exact lowercase `"true"` enables |
| `WORKER_POLL_INTERVAL_MS` | `10000` | Worker poll interval (bounded 1s–5min) |
| `HEARTBEAT_INTERVAL_MS` | `20000` | Worker heartbeat frequency (bounded 1s–10min) |
| `STALE_HEARTBEAT_MS` | `300000` | 5 min; threshold for stale-job recovery |

---

## Known Limitations

1. **Bundle size**: The frontend JavaScript bundle is 672 KB (199 KB gzipped). Vite emits a chunk-size warning. This does not affect correctness but adds ~1 s load time on slow connections.

2. **Integration tests require `DATABASE_URL`**: The integration test suite (`test:integration`) runs against a real PostgreSQL database. Without `DATABASE_URL` set the tests are skipped/error. In environments without a DB, only unit tests (`test`) can run.

3. **Worker is single-process**: The worker runs in the same Node process as the API server. For high throughput, a separate dedicated worker process would be preferable, but the heartbeat mechanism handles crashed workers correctly.

4. **Manual retry of failed runs**: Currently a user must re-create the service to trigger a new research run after a persistent failure. A UI retry button is proposed as a follow-up task.

5. **`vite build` PORT placeholder**: The `vite.config.ts` files for `renewal-scout` and `mockup-sandbox` now use port 8080 as a build-time placeholder when `PORT` is not set. This has no effect on the built output (server config is not embedded in the build artifact) but the constraint bears documenting.

---

## Source Export

`renewal-scout-export.txt` — complete plain-text dump of all source files (33,642 lines). Excludes `node_modules`, `.git`, build output, `.env*`, and the ZIP itself.
