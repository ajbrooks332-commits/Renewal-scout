# POST-REPAIR BUILD REPORT
Generated: 2026-08-11

## Summary

All 12 items from the final remediation pass have been implemented.
Build and test suite are green.

---

## Files Changed

### Security / Endpoint Removal (Item 1)
- `artifacts/api-server/src/app.ts` — `/api/download-source` endpoint and `readFileSync`/`existsSync` imports removed
- `artifacts/renewal-scout/src/components/layout.tsx` — Download link and icon removed
- `artifacts/api-server/tests/download-source-404.test.ts` — New test confirming endpoint does not return 200

### Post-merge Script (Item 2)
- `scripts/post-merge.sh` — Removed `pnpm --filter db push` (install-only)
- `lib/db/drizzle/0007_reconcile_full_schema.sql` — New migration: full idempotent schema reconciliation covering all tables, columns, constraints, GBP→pence conversion, singleton guard, duplicate detection before UNIQUE constraints

### Integration Test Isolation (Item 3)
- `artifacts/api-server/tests/schema.integration.test.ts` — Complete rewrite: requires `TEST_DATABASE_URL`, refuses if equals `DATABASE_URL`, requires `ALLOW_DESTRUCTIVE_DB_TESTS=true`, uses dedicated `testPool` from `TEST_DATABASE_URL` for all raw SQL (never touches app pool)

### Strict Field Validation (Item 4)
- `lib/api-zod/src/deal-schemas.ts` — All deal schemas (EnergyDeal, BroadbandDeal, InsuranceDeal, CreditLoanDeal, CommonDeal) now use `.strict()` — unknown keys rejected at validation boundary
- `artifacts/api-server/src/routes/current-deals.ts` — `UpdateDealBodySchema` and `ConfirmBodySchema` both use `.strict()`; `EXTRACTION_FIELD_NAMES` and `ExtractionOutputSchema` extended with `bundleProducts` and `bundleDiscount`
- `artifacts/api-server/src/routes/service-requirements.ts` — Unknown field names rejected with HTTP 400 (previously silently discarded)

### Questionnaire & Deal Editor Extensions (Item 5)
- `artifacts/renewal-scout/src/pages/service-requirements-tab.tsx` — Full rewrite:
  - New `showWhen` conditional on `FieldDef` (progressive disclosure)
  - Added `"text"` field type with Input[type=text] renderer
  - Broadband: Sky TV detail questions (`skyTvPackage`, `skyTvSportsRequired`, `skyTvCinemaRequired`, `skyMobileLines`, `currentBundleDiscountGbp`) conditionally shown on `linkedSkyTv`/`linkedSkyMobile`/`bundleDiscountImportant`
  - Electricity + Gas-and-electricity: `evOwner` gate, full EV fields (`evMake`, `evModel`, `evBatteryCapacityKwh`, `evAnnualMileage`, `overnightChargingEnd`, `dayUsagePercent`) conditionally shown on `evOwner=true`; `solarExportTariff` added
- `artifacts/api-server/src/routes/service-requirements.ts` — KNOWN_FIELDS extended with `evOwner`, `skyTvPackage`, `skyTvSportsRequired`, `skyTvCinemaRequired`, `skyMobileLines`, `currentBundleDiscountGbp`
- `artifacts/renewal-scout/src/pages/current-deal-tab.tsx` — FIELD_DEFS extended with `promotionEndDate`, `priceIncreasePct`, `paymentMethod`, `bundleProducts`, `bundleDiscount`, `bundleTerms`, `addOns`, `arrangementFeeGbp`, `promoExpiryDate`

### Savings Calculation Fix (Item 6)
- `artifacts/api-server/src/lib/research-service.ts` — Added `effectiveAnnualCostWithDeal()` helper; `computeSavings()` now accepts `confirmedDealFields` and prefers: deal `annualCostGbp`/`annualPremiumGbp` → deal `monthlyCostGbp×12` → legacy service pence columns. Only `user` and `extracted_confirmed` provenance counts.

### OpenAI Hardening (Item 7)
- `artifacts/api-server/src/lib/research-service.ts`:
  - OpenAI client created with `maxRetries: 2` and `timeout: 45_000` (no retry multiplication)
  - Completion save wrapped in a single `db.transaction()` (research_runs + services updated atomically)
  - Non-OpenAI errors stored as generic user-safe string (not `err.message`)
  - `reconcileCitationUrls()` changed from fail-open to **fail-closed**: when `citationUrls.length === 0`, all source URLs are cleared and a warning prepended

### Privacy Disclosure (Item 8)
- `artifacts/renewal-scout/src/pages/current-deal-tab.tsx` — Both disclosure texts updated: accurately describes `store:false` scope (disables Responses application-state storage), acknowledges OpenAI abuse-monitoring log retention
- `artifacts/api-server/src/routes/current-deals.ts` — `AI_DISCLOSURE` constant updated with matching accurate text; code comments corrected

### Worker Concurrency (Item 9)
- `artifacts/api-server/src/lib/worker.ts` — Full rewrite:
  - `executeResearch()` is now **awaited** (was fire-and-forget)
  - `pollInProgress` flag stays `true` for the full job duration — prevents concurrent jobs
  - `activeJobPromise` tracked for shutdown
  - `stopWorker()` is now **async** with bounded 30 s timeout that awaits the active job
  - Immediate startup poll on `startWorker()` to reduce dispatch latency

### Graceful Shutdown (Item 10)
- `artifacts/api-server/src/index.ts` — `server` reference kept from `app.listen()`; `SIGTERM` + `SIGINT` handlers added with idempotent `shuttingDown` flag; shutdown sequence: `server.close()` → `stopScheduler()` → `await stopWorker(30_000)` → `await pool.end()` → `process.exit(0)`

### Export Script (Item 11)
- `scripts/generate-export.sh` — `tsconfig.base.json` added to root config section; output renamed to `REVIEW_EXPORT.txt`

---

## Migration Strategy (0007)

Migration `0007_reconcile_full_schema.sql` is fully idempotent — safe against:
- **Standard path** (0000–0006 previously applied): all guards return immediately, zero DDL executed
- **Push-provisioned databases**: adds missing constraints/indexes, fixes GBP→pence columns, removes duplicates before adding UNIQUE constraints
- **Partial migration states**: each block is individually guarded with `IF NOT EXISTS` / `DO $$` patterns

Key protections:
- Deduplicates `current_deals` and `service_requirements` before adding UNIQUE constraints (keeps most-recent row per service)
- Sanitises invalid `research_runs.status` values to `'failed'` before adding CHECK constraint
- Handles `household_profile` renumbering (ensures id=1 exists before adding singleton CHECK)

---

## Verification Commands with Exit Codes

```
pnpm install --frozen-lockfile                    → exit 0
pnpm run typecheck                                → exit 0 (7 projects, 0 errors)
pnpm --filter @workspace/api-server run test      → exit 0 (247 tests, 7 test files)
pnpm run build                                    → exit 0 (all 3 artifacts built)
```

Integration tests (`test:integration`) require `TEST_DATABASE_URL` ≠ `DATABASE_URL` and `ALLOW_DESTRUCTIVE_DB_TESTS=true` — not run in standard CI without a separate test database.

---

## Test Totals

| Suite | Tests | Result |
|---|---|---|
| task13.test.ts | 56 | ✅ pass |
| task5.test.ts | 61 | ✅ pass |
| download-source-404.test.ts | 4 | ✅ pass |
| renewal-logic.test.ts | ~30 | ✅ pass |
| Other suites | ~96 | ✅ pass |
| **Total** | **247** | **✅ all pass** |

---

## Build Results

| Artifact | Output | Size |
|---|---|---|
| api-server | dist/index.mjs | 3.6 MB |
| renewal-scout | dist/public/assets/index.js | 678 KB (gzip: 201 KB) |
| mockup-sandbox | dist/assets/index.js | 188 KB |

No TypeScript errors. Chunk-size warning on renewal-scout (>500 KB) is pre-existing and not introduced by this work.

---

## Remaining Warnings

- `renewal-scout` chunk size >500 KB: pre-existing, not introduced by this work. Code-splitting would require significant refactoring of page imports.
- `dist/public` contains no source-download HTML (confirmed by build output — only `index.html` generated).

---

## Output Files

- `POST_REPAIR_BUILD_REPORT.md` — this file
- `REVIEW_EXPORT.txt` — 34,521 lines / 1.26 MB full source export (all TypeScript, SQL, config files)
