---
name: Deal schema validation — strict mode
description: All deal schemas use .strict() — unknown keys cause HTTP 400, not silent strip. Tests updated.
---

# Deal schema validation

All schemas in `lib/api-zod/src/deal-schemas.ts` now call `.strict()` on the final exported variants (EnergyDealStrict, BroadbandDealStrict, etc.). The DEAL_SCHEMAS_BY_SERVICE_TYPE map and FALLBACK_DEAL_SCHEMA use the strict variants.

**Why:** Silent stripping of unknown keys allowed client bugs to go undetected and prevented cross-service field leakage detection.

**How to apply:**
- `validateDealValues()` will now return `{ success: false }` for any key not declared in the schema — the route must return HTTP 400.
- `UpdateDealBodySchema` and `ConfirmBodySchema` in `current-deals.ts` also use `.strict()`.
- The existing test "ignores unknown field names" was updated to expect 400 (not 200) — future tests for the PUT endpoint should expect 400 for unknown keys.
- Adding a new field to a deal schema requires adding it to the Zod schema AND EXTRACTION_FIELD_NAMES (for document extraction to return it).
