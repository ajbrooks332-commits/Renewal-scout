---
name: Citation reconciliation — fail-closed behavior
description: reconcileCitationUrls() clears all URLs when citationUrls.length===0 (was fail-open).
---

# Citation reconciliation fail-closed

`reconcileCitationUrls()` in `research-service.ts` now FAILS CLOSED when `citationUrls.length === 0`:
- All `report.sources` cleared
- All `opt.source_urls` cleared for each option
- Warning prepended: "Source URLs could not be verified against search citations — links have been removed."

**Why:** Keeping unverified model-generated URLs open when no citation annotations were returned risked serving hallucinated links to users.

**How to apply:**
- The task13 unit test for this function was updated — it now asserts `sources.length === 0` and that warnings contain "could not be verified" when citations are empty.
- Any future test for zero-citation scenarios must expect cleared URLs, not preserved ones.
