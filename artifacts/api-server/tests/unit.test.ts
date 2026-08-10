import { describe, it, expect, vi, beforeEach } from "vitest";
import { sanitiseReport, validUrl, queueResearch } from "../src/lib/research-service";
import { validateServiceInput, trimServiceInput, isValidIsoDate } from "../src/lib/validation";
import { db } from "@workspace/db";

// Helper — builds a mock drizzle chain that resolves to `finalValue`.
// Mirrors the makeChain in tests/setup.ts.
function makeChain(finalValue: unknown = []) {
  const resolved = Promise.resolve(finalValue);
  const chain: Record<string, (...args: unknown[]) => unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    set: () => chain,
    values: () => chain,
    onConflictDoNothing: () => chain,
    limit: () => resolved,
    returning: () => resolved,
    then: (
      onfulfilled?: (v: unknown) => unknown,
      onrejected?: (r: unknown) => unknown,
    ) => resolved.then(onfulfilled, onrejected),
    catch: (onrejected?: (r: unknown) => unknown) => resolved.catch(onrejected),
    finally: (onfinally?: () => void) => resolved.finally(onfinally),
  };
  return chain as ReturnType<typeof db.select>;
}

// ─── URL sanitisation ─────────────────────────────────────────────────────────

describe("validUrl", () => {
  it("accepts http and https URLs", () => {
    expect(validUrl("https://example.com")).toBe(true);
    expect(validUrl("http://example.com/path?q=1")).toBe(true);
  });

  it("rejects non-http schemes", () => {
    expect(validUrl("javascript:alert(1)")).toBe(false);
    expect(validUrl("ftp://example.com")).toBe(false);
    expect(validUrl("data:text/html,<h1>x</h1>")).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(validUrl("not-a-url")).toBe(false);
    expect(validUrl("")).toBe(false);
  });
});

describe("sanitiseReport", () => {
  it("filters invalid source URLs and deduplicates", () => {
    const report = {
      service_type: "Broadband",
      as_of_date: "2026-08-10",
      scope_statement: "test",
      current_deal_assessment: "test",
      options: [],
      recommended_next_step: "test",
      estimated_annual_saving_gbp: null,
      missing_information: [],
      comparison_checklist: [],
      application_pack: [],
      warnings: [],
      sources: [
        "https://good.com",
        "javascript:evil()",
        "https://good.com", // duplicate
        "ftp://bad.com",
      ],
    };
    const result = sanitiseReport(report);
    expect(result.sources).toEqual(["https://good.com"]);
  });

  it("sanitises source_urls inside options", () => {
    const report = {
      service_type: "Energy",
      as_of_date: "2026-08-10",
      scope_statement: "test",
      current_deal_assessment: "test",
      options: [
        {
          provider: "Octopus",
          product_name: "Agile",
          price_status: "indicative" as const,
          annual_cost_gbp: 1200,
          monthly_cost_gbp: 100,
          contract_length_months: 12,
          headline_terms: [],
          important_exclusions: [],
          source_urls: ["https://octopus.energy", "javascript:bad()"],
        },
      ],
      recommended_next_step: "test",
      estimated_annual_saving_gbp: null,
      missing_information: [],
      comparison_checklist: [],
      application_pack: [],
      warnings: [],
      sources: [],
    };
    const result = sanitiseReport(report);
    expect(result.options[0].source_urls).toEqual(["https://octopus.energy"]);
  });
});

// ─── Input validation ─────────────────────────────────────────────────────────

describe("isValidIsoDate", () => {
  it("accepts valid ISO dates", () => {
    expect(isValidIsoDate("2026-01-15")).toBe(true);
    expect(isValidIsoDate("2024-12-31")).toBe(true);
  });

  it("rejects non-ISO formats", () => {
    expect(isValidIsoDate("15/01/2026")).toBe(false);
    expect(isValidIsoDate("2026-1-5")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate(123)).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });

  it("rejects invalid calendar dates", () => {
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false);
  });
});

describe("validateServiceInput", () => {
  it("returns no errors for valid input", () => {
    const errors = validateServiceInput({
      provider: "BT",
      monthlyCostGbp: 30,
      annualCostGbp: 360,
      renewalDate: "2026-12-01",
      contractEndDate: "2027-01-01",
      currentTerms: "Standard broadband",
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects negative monthly cost", () => {
    const errors = validateServiceInput({ monthlyCostGbp: -1 });
    expect(errors.some((e) => e.field === "monthlyCostGbp")).toBe(true);
  });

  it("rejects negative annual cost", () => {
    const errors = validateServiceInput({ annualCostGbp: -100 });
    expect(errors.some((e) => e.field === "annualCostGbp")).toBe(true);
  });

  it("accepts zero costs", () => {
    const errors = validateServiceInput({
      monthlyCostGbp: 0,
      annualCostGbp: 0,
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects invalid renewal date format", () => {
    const errors = validateServiceInput({ renewalDate: "01/12/2026" });
    expect(errors.some((e) => e.field === "renewalDate")).toBe(true);
  });

  it("rejects invalid contract end date format", () => {
    const errors = validateServiceInput({ contractEndDate: "not-a-date" });
    expect(errors.some((e) => e.field === "contractEndDate")).toBe(true);
  });

  it("rejects provider longer than 255 chars", () => {
    const errors = validateServiceInput({ provider: "x".repeat(256) });
    expect(errors.some((e) => e.field === "provider")).toBe(true);
  });

  it("rejects currentTerms longer than 5000 chars", () => {
    const errors = validateServiceInput({ currentTerms: "x".repeat(5001) });
    expect(errors.some((e) => e.field === "currentTerms")).toBe(true);
  });

  it("allows null/undefined optional fields", () => {
    const errors = validateServiceInput({
      monthlyCostGbp: null,
      renewalDate: null,
      contractEndDate: undefined,
    });
    expect(errors).toHaveLength(0);
  });
});

describe("trimServiceInput", () => {
  it("trims whitespace from provider and location", () => {
    const result = trimServiceInput({
      provider: "  BT  ",
      location: "\t London \n",
      productName: " Fibre 2 ",
    });
    expect(result["provider"]).toBe("BT");
    expect(result["location"]).toBe("London");
    expect(result["productName"]).toBe("Fibre 2");
  });

  it("does not mutate the original object", () => {
    const original = { provider: "  BT  " };
    trimServiceInput(original);
    expect(original.provider).toBe("  BT  ");
  });
});

// ─── AI report Zod schema parsing (mocked OpenAI output) ────────────────────

describe("DealReport Zod validation (import-level test)", () => {
  it("valid report parses successfully", async () => {
    const { DealReportSchema } = await import("../src/lib/research-service-schema");
    const validReport = {
      service_type: "Broadband",
      as_of_date: "2026-08-10",
      scope_statement: "UK broadband comparison",
      current_deal_assessment: "Current deal is above market rate",
      options: [
        {
          provider: "BT",
          product_name: "Full Fibre 100",
          price_status: "confirmed_public",
          annual_cost_gbp: 420,
          monthly_cost_gbp: 35,
          contract_length_months: 24,
          headline_terms: ["100Mbps", "Free router"],
          important_exclusions: [],
          source_urls: ["https://bt.com"],
        },
      ],
      recommended_next_step: "Compare with Vodafone",
      estimated_annual_saving_gbp: 120,
      missing_information: [],
      comparison_checklist: ["Check exit fees"],
      application_pack: ["Current bill"],
      warnings: [],
      sources: ["https://bt.com"],
    };
    const result = DealReportSchema.safeParse(validReport);
    expect(result.success).toBe(true);
  });

  it("rejects report missing required fields", async () => {
    const { DealReportSchema } = await import("../src/lib/research-service-schema");
    const result = DealReportSchema.safeParse({ service_type: "Broadband" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid price_status enum", async () => {
    const { DealReportSchema } = await import("../src/lib/research-service-schema");
    const result = DealReportSchema.safeParse({
      service_type: "Broadband",
      as_of_date: "2026-08-10",
      scope_statement: "test",
      current_deal_assessment: "test",
      options: [
        {
          provider: "BT",
          product_name: "X",
          price_status: "best_deal", // invalid
          annual_cost_gbp: null,
          monthly_cost_gbp: null,
          contract_length_months: null,
          headline_terms: [],
          important_exclusions: [],
          source_urls: [],
        },
      ],
      recommended_next_step: "test",
      estimated_annual_saving_gbp: null,
      missing_information: [],
      comparison_checklist: [],
      application_pack: [],
      warnings: [],
      sources: [],
    });
    expect(result.success).toBe(false);
  });
});

// ─── queueResearch idempotency & conflict handling ────────────────────────────

describe("queueResearch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns existing run ID when an active run already exists (idempotent)", async () => {
    // Scenario: two concurrent callers — first wins the insert, second sees
    // the active run at the application-level check and returns immediately.
    const activeRun = { id: 42, serviceId: 1, status: "queued" as const };
    const service = { id: 1, active: true };

    // Service lookup
    vi.mocked(db.select).mockImplementationOnce(() =>
      makeChain([service]),
    );
    // Application-level existing-run check → returns the active run
    vi.mocked(db.select).mockImplementationOnce(() =>
      makeChain([activeRun]),
    );

    const runId = await queueResearch(1, "manual");
    expect(runId).toBe(42);
    // Insert must NOT have been called
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });

  it("creates a new run when no active run exists", async () => {
    const service = { id: 1, active: true };
    const newRun = { id: 99, serviceId: 1, status: "queued" as const };

    // Service lookup
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([service]));
    // Application-level check → no active run
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([]));
    // Insert succeeds
    vi.mocked(db.insert).mockImplementationOnce(() => makeChain([newRun]));

    const runId = await queueResearch(1, "manual");
    expect(runId).toBe(99);
  });

  it("handles DB-level conflict (ON CONFLICT DO NOTHING) by fetching the winner", async () => {
    // Scenario: application-level check misses the race (returns empty), but
    // the DB index fires, making insert return empty.  The function then
    // fetches the run inserted by the other caller.
    const service = { id: 1, active: true };
    const winnerRun = { id: 77, serviceId: 1, status: "queued" as const };

    // Service lookup
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([service]));
    // Application-level check → misses the race, returns empty
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([]));
    // Insert → conflict, returns empty (ON CONFLICT DO NOTHING)
    vi.mocked(db.insert).mockImplementationOnce(() => makeChain([]));
    // Post-conflict fetch → returns the winner
    vi.mocked(db.select).mockImplementationOnce(() =>
      makeChain([winnerRun]),
    );

    const runId = await queueResearch(1, "manual");
    expect(runId).toBe(77);
  });

  it("throws when service is not found", async () => {
    // Service lookup returns empty → throws
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([]));

    await expect(queueResearch(999, "manual")).rejects.toThrow(
      "Service not found or archived.",
    );
  });
});
