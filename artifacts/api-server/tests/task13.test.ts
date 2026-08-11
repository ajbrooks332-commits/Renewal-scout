/**
 * Tests for Task #13 — OpenAI research hardening, PG job queue, and
 * per-service prompt allowlists.
 *
 * All tests use the global DB mock from tests/setup.ts.
 * No real DB or OpenAI connections are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  filterProfileForService,
  addMandatoryWarnings,
  computeSavings,
  reconcileCitationUrls,
  sanitiseReport,
  validUrl,
} from "../src/lib/research-service";
import { DealReportSchema } from "../src/lib/research-service-schema";
import { isSchedulerEnabled, validateSchedulerConfig } from "../src/lib/scheduler";
import { db } from "@workspace/db";
import type { DealReport } from "../src/lib/research-service-schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    then: (onfulfilled?: (v: unknown) => unknown, onrejected?: (r: unknown) => unknown) =>
      resolved.then(onfulfilled, onrejected),
    catch: (onrejected?: (r: unknown) => unknown) => resolved.catch(onrejected),
    finally: (onfinally?: () => void) => resolved.finally(onfinally),
  };
  return chain as ReturnType<typeof db.select>;
}

function makeBaseReport(overrides: Partial<DealReport> = {}): DealReport {
  return {
    service_type: "Broadband",
    as_of_date: "2026-08-10",
    scope_statement: "Test scope",
    current_deal_assessment: "Test assessment",
    options: [],
    recommended_next_step: "Test step",
    estimated_annual_saving_gbp: null,
    missing_information: [],
    comparison_checklist: [],
    application_pack: [],
    warnings: [],
    sources: [],
    comparison_based_on: [],
    ...overrides,
  };
}

function makeOption(overrides: Partial<DealReport["options"][0]> = {}): DealReport["options"][0] {
  return {
    provider: "BT",
    product_name: "Fibre 50",
    price_status: "confirmed_public",
    annual_cost_gbp: 400,
    monthly_cost_gbp: 33.33,
    contract_length_months: 24,
    headline_terms: [],
    important_exclusions: [],
    source_urls: [],
    ...overrides,
  };
}

// ─── filterProfileForService ──────────────────────────────────────────────────

describe("filterProfileForService — per-service allowlists", () => {
  const fullProfile = {
    postcode: "SW1A 1AA",
    numAdults: 2,
    numChildren: 1,
    smoker: true,
    carMake: "Tesla",
    carModel: "Model 3",
    annualMileage: 10000,
    claimsLast5Years: 0,
    carValuePence: 3000000,
    annualElectricityKwh: 3100,
    annualGasKwh: 12000,
    heatingType: "gas",
    hasEv: true,
    hasSolar: false,
    propertyType: "semi-detached",
    tenure: "owned",
    bedrooms: 3,
    yearBuilt: 1990,
    drivingExperience: 10,
  };

  it("broadband prompt only includes postcode and numAdults", () => {
    const filtered = filterProfileForService(fullProfile, "Broadband");
    expect(filtered).toEqual({ postcode: "SW1A 1AA", numAdults: 2 });
    // Critical: no smoker status, no vehicle data, no claims history
    expect(filtered).not.toHaveProperty("smoker");
    expect(filtered).not.toHaveProperty("carMake");
    expect(filtered).not.toHaveProperty("claimsLast5Years");
    expect(filtered).not.toHaveProperty("carValuePence");
  });

  it("car insurance prompt includes car, mileage, and claims — not smoker status", () => {
    const filtered = filterProfileForService(fullProfile, "Car insurance");
    expect(filtered).toHaveProperty("carMake", "Tesla");
    expect(filtered).toHaveProperty("annualMileage", 10000);
    expect(filtered).toHaveProperty("claimsLast5Years", 0);
    // No smoker status: irrelevant and potentially inappropriate
    expect(filtered).not.toHaveProperty("smoker");
  });

  it("electricity prompt includes EV usage — not smoker status or vehicle value", () => {
    const filtered = filterProfileForService(fullProfile, "Electricity");
    expect(filtered).toHaveProperty("hasEv", true);
    expect(filtered).toHaveProperty("annualElectricityKwh", 3100);
    expect(filtered).not.toHaveProperty("smoker");
    expect(filtered).not.toHaveProperty("carValuePence");
  });

  it("gas and electricity prompt includes both energy usage fields", () => {
    const filtered = filterProfileForService(fullProfile, "Gas and electricity");
    expect(filtered).toHaveProperty("annualElectricityKwh", 3100);
    expect(filtered).toHaveProperty("annualGasKwh", 12000);
    expect(filtered).toHaveProperty("heatingType", "gas");
    expect(filtered).not.toHaveProperty("carMake");
  });

  it("life insurance prompt includes smoker status and occupant counts", () => {
    const filtered = filterProfileForService(fullProfile, "Life insurance");
    expect(filtered).toHaveProperty("smoker", true);
    expect(filtered).toHaveProperty("numAdults", 2);
    expect(filtered).toHaveProperty("numChildren", 1);
    // No vehicle data — not relevant for life insurance
    expect(filtered).not.toHaveProperty("carMake");
    expect(filtered).not.toHaveProperty("annualMileage");
  });

  it("home insurance prompt includes property details", () => {
    const filtered = filterProfileForService(fullProfile, "Home insurance");
    expect(filtered).toHaveProperty("propertyType", "semi-detached");
    expect(filtered).toHaveProperty("tenure", "owned");
    expect(filtered).toHaveProperty("bedrooms", 3);
    // No vehicle or life data
    expect(filtered).not.toHaveProperty("carMake");
    expect(filtered).not.toHaveProperty("smoker");
  });

  it("unknown service type receives EMPTY profile (deny-by-default, not full PII)", () => {
    // Unknown types must not receive the full household record — they have not
    // been reviewed for which fields are safe to send to OpenAI.
    // null means no household context is included in the prompt.
    const filtered = filterProfileForService(fullProfile, "SuperNewService");
    expect(filtered).toBeNull();
  });

  it("'Other' service type receives empty profile (explicitly restricted)", () => {
    const filtered = filterProfileForService(fullProfile, "Other");
    expect(filtered).toBeNull();
  });

  it("returns null when profile is null", () => {
    expect(filterProfileForService(null, "Broadband")).toBeNull();
  });

  it("returns null when all allowed fields are absent from profile", () => {
    // Profile has no fields in the Broadband allowlist
    const filtered = filterProfileForService({ smoker: true, carMake: "BMW" }, "Broadband");
    expect(filtered).toBeNull();
  });
});

// ─── addMandatoryWarnings ─────────────────────────────────────────────────────

describe("addMandatoryWarnings — server-generated warnings", () => {
  it("prepends life insurance warning to warnings array", () => {
    const report = makeBaseReport({ service_type: "Life insurance", warnings: ["existing"] });
    addMandatoryWarnings(report, "Life insurance");
    expect(report.warnings[0]).toMatch(/regulated financial advice/i);
    expect(report.warnings).toContain("existing");
    expect(report.warnings.length).toBe(2);
  });

  it("prepends credit card warning", () => {
    const report = makeBaseReport({ service_type: "Credit card", warnings: [] });
    addMandatoryWarnings(report, "Credit card");
    expect(report.warnings[0]).toMatch(/hard credit search/i);
  });

  it("prepends loan warning", () => {
    const report = makeBaseReport({ service_type: "Loan", warnings: [] });
    addMandatoryWarnings(report, "Loan");
    expect(report.warnings[0]).toMatch(/credit application/i);
  });

  it("does not duplicate warning if already present", () => {
    const report = makeBaseReport({ service_type: "Life insurance", warnings: [] });
    addMandatoryWarnings(report, "Life insurance");
    addMandatoryWarnings(report, "Life insurance"); // called twice
    expect(report.warnings.length).toBe(1);
  });

  it("adds no warning for broadband (no mandatory warning)", () => {
    const report = makeBaseReport({ service_type: "Broadband", warnings: ["some warning"] });
    addMandatoryWarnings(report, "Broadband");
    expect(report.warnings.length).toBe(1);
    expect(report.warnings[0]).toBe("some warning");
  });
});

// ─── computeSavings ───────────────────────────────────────────────────────────

describe("computeSavings — server-side savings calculation", () => {
  function makeService(overrides: Partial<{
    monthlyCostPence: number | null;
    annualCostPence: number | null;
  }> = {}) {
    return {
      id: 1,
      serviceType: "Broadband",
      provider: "BT",
      monthlyCostPence: 5000, // £50/month → £600/year
      annualCostPence: null,
      renewalDate: null,
      contractEndDate: null,
      ...overrides,
    } as Parameters<typeof computeSavings>[1];
  }

  it("computes savings from monthly cost when annual is not set", () => {
    const report = makeBaseReport({
      options: [makeOption({ annual_cost_gbp: 400, price_status: "confirmed_public" })],
    });
    const service = makeService({ monthlyCostPence: 5000 }); // £600/year
    const savings = computeSavings(report, service);
    expect(savings).toBeCloseTo(200, 1); // 600 - 400
  });

  it("prefers annual_cost_gbp from service when available", () => {
    const report = makeBaseReport({
      options: [makeOption({ annual_cost_gbp: 550, price_status: "confirmed_public" })],
    });
    const service = makeService({ annualCostPence: 72000, monthlyCostPence: null }); // £720/year
    const savings = computeSavings(report, service);
    expect(savings).toBeCloseTo(170, 1); // 720 - 550
  });

  it("returns null when all options require personal quotes", () => {
    const report = makeBaseReport({
      options: [
        makeOption({ price_status: "personal_quote_required", annual_cost_gbp: null }),
      ],
    });
    expect(computeSavings(report, makeService())).toBeNull();
  });

  it("returns null when no current cost is set on the service", () => {
    const report = makeBaseReport({
      options: [makeOption({ annual_cost_gbp: 400, price_status: "confirmed_public" })],
    });
    expect(
      computeSavings(report, makeService({ monthlyCostPence: null, annualCostPence: null })),
    ).toBeNull();
  });

  it("returns null when best option is more expensive than current deal (no savings)", () => {
    const report = makeBaseReport({
      options: [makeOption({ annual_cost_gbp: 700, price_status: "confirmed_public" })],
    });
    const service = makeService({ monthlyCostPence: 5000 }); // £600/year — cheaper than option
    expect(computeSavings(report, service)).toBeNull();
  });

  it("returns the largest saving when multiple options are present", () => {
    const report = makeBaseReport({
      options: [
        makeOption({ annual_cost_gbp: 500, price_status: "confirmed_public" }), // saves £100
        makeOption({ annual_cost_gbp: 450, price_status: "confirmed_public", provider: "Sky" }), // saves £150
        makeOption({ annual_cost_gbp: 550, price_status: "confirmed_public", provider: "Virgin" }), // saves £50
      ],
    });
    const service = makeService({ monthlyCostPence: 5000 }); // £600/year
    expect(computeSavings(report, service)).toBeCloseTo(150, 1); // best option at £450
  });
});

// ─── reconcileCitationUrls ───────────────────────────────────────────────────

describe("reconcileCitationUrls — citation URL reconciliation", () => {
  it("when citations non-empty, only annotated URLs survive in sources", () => {
    const report = makeBaseReport({
      sources: [
        "https://bt.com/broadband",
        "https://sky.com/broadband",
        "https://invented-source.example.com", // NOT in annotations
      ],
    });
    const citationUrls = ["https://bt.com/broadband", "https://sky.com/broadband"];
    const result = reconcileCitationUrls(report, citationUrls);
    expect(result.sources).toContain("https://bt.com/broadband");
    expect(result.sources).toContain("https://sky.com/broadband");
    expect(result.sources).not.toContain("https://invented-source.example.com");
  });

  it("when citations non-empty, filters option source_urls to annotation set", () => {
    const report = makeBaseReport({
      options: [
        makeOption({
          source_urls: [
            "https://bt.com/offer",
            "https://fabricated-offer.com", // NOT in annotations
          ],
        }),
      ],
    });
    const citationUrls = ["https://bt.com/offer"];
    const result = reconcileCitationUrls(report, citationUrls);
    expect(result.options[0].source_urls).toEqual(["https://bt.com/offer"]);
  });

  it("keeps all valid sources when no citations returned (fail-open)", () => {
    const report = makeBaseReport({
      sources: ["https://bt.com/broadband", "https://sky.com/broadband"],
    });
    const result = reconcileCitationUrls(report, []); // empty citations
    expect(result.sources).toContain("https://bt.com/broadband");
    expect(result.sources).toContain("https://sky.com/broadband");
  });

  it("uses citation set as the definitive sources list (not merged with report sources)", () => {
    // Citation URLs that are NOT in report.sources should be added;
    // report URLs not in citations should be removed.
    const report = makeBaseReport({
      sources: ["https://bt.com/old-page"], // old, will be replaced
    });
    const citationUrls = ["https://bt.com/new-page", "https://ofcom.org.uk/data"];
    const result = reconcileCitationUrls(report, citationUrls);
    expect(result.sources).toContain("https://bt.com/new-page");
    expect(result.sources).toContain("https://ofcom.org.uk/data");
    expect(result.sources).not.toContain("https://bt.com/old-page");
  });
});

// ─── DealReportSchema — schema hardening ─────────────────────────────────────

describe("DealReportSchema — Zod validation hardening", () => {
  it("rejects more than 3 options in the options array", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [
        makeOption({ provider: "A" }),
        makeOption({ provider: "B" }),
        makeOption({ provider: "C" }),
        makeOption({ provider: "D" }), // 4th option — should fail
      ],
    }));
    expect(result.success).toBe(false);
  });

  it("accepts up to 3 options", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [
        makeOption({ provider: "A" }),
        makeOption({ provider: "B" }),
        makeOption({ provider: "C" }),
      ],
    }));
    expect(result.success).toBe(true);
  });

  it("rejects negative annual_cost_gbp", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [makeOption({ annual_cost_gbp: -100 })],
    }));
    expect(result.success).toBe(false);
  });

  it("rejects Infinity in annual_cost_gbp", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [makeOption({ annual_cost_gbp: Infinity })],
    }));
    expect(result.success).toBe(false);
  });

  it("rejects negative monthly_cost_gbp", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [makeOption({ monthly_cost_gbp: -5 })],
    }));
    expect(result.success).toBe(false);
  });

  it("accepts null costs (personalised quote required)", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({
      options: [makeOption({ annual_cost_gbp: null, monthly_cost_gbp: null })],
    }));
    expect(result.success).toBe(true);
  });

  it("rejects as_of_date that is not YYYY-MM-DD format", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({ as_of_date: "10/08/2026" }));
    expect(result.success).toBe(false);
  });

  it("accepts valid YYYY-MM-DD as_of_date", () => {
    const result = DealReportSchema.safeParse(makeBaseReport({ as_of_date: "2026-08-11" }));
    expect(result.success).toBe(true);
  });
});

// ─── isSchedulerEnabled — strict parsing ─────────────────────────────────────

describe("isSchedulerEnabled — strict SCHEDULER_ENABLED parsing", () => {
  const orig = process.env["SCHEDULER_ENABLED"];
  afterEach(() => {
    if (orig === undefined) {
      delete process.env["SCHEDULER_ENABLED"];
    } else {
      process.env["SCHEDULER_ENABLED"] = orig;
    }
  });

  it("returns true for 'true' (lowercase)", () => {
    process.env["SCHEDULER_ENABLED"] = "true";
    expect(isSchedulerEnabled()).toBe(true);
  });

  it("returns true for 'TRUE' (uppercase)", () => {
    process.env["SCHEDULER_ENABLED"] = "TRUE";
    expect(isSchedulerEnabled()).toBe(true);
  });

  it("returns true for 'True' (mixed case)", () => {
    process.env["SCHEDULER_ENABLED"] = "True";
    expect(isSchedulerEnabled()).toBe(true);
  });

  it("returns false for '1'", () => {
    process.env["SCHEDULER_ENABLED"] = "1";
    expect(isSchedulerEnabled()).toBe(false);
  });

  it("returns false for 'yes'", () => {
    process.env["SCHEDULER_ENABLED"] = "yes";
    expect(isSchedulerEnabled()).toBe(false);
  });

  it("returns false for 'false'", () => {
    process.env["SCHEDULER_ENABLED"] = "false";
    expect(isSchedulerEnabled()).toBe(false);
  });

  it("returns false when SCHEDULER_ENABLED is unset", () => {
    delete process.env["SCHEDULER_ENABLED"];
    expect(isSchedulerEnabled()).toBe(false);
  });
});

// ─── validateSchedulerConfig ──────────────────────────────────────────────────

describe("validateSchedulerConfig — startup config validation", () => {
  const savedHour = process.env["SCHEDULER_HOUR"];
  const savedMin = process.env["SCHEDULER_MINUTE"];
  const savedTz = process.env["APP_TIMEZONE"];

  afterEach(() => {
    if (savedHour === undefined) delete process.env["SCHEDULER_HOUR"];
    else process.env["SCHEDULER_HOUR"] = savedHour;
    if (savedMin === undefined) delete process.env["SCHEDULER_MINUTE"];
    else process.env["SCHEDULER_MINUTE"] = savedMin;
    if (savedTz === undefined) delete process.env["APP_TIMEZONE"];
    else process.env["APP_TIMEZONE"] = savedTz;
  });

  it("returns no warnings for valid config", () => {
    process.env["SCHEDULER_HOUR"] = "7";
    process.env["SCHEDULER_MINUTE"] = "30";
    process.env["APP_TIMEZONE"] = "Europe/London";
    expect(validateSchedulerConfig()).toEqual([]);
  });

  it("returns warning for out-of-range hour (24)", () => {
    process.env["SCHEDULER_HOUR"] = "24";
    const warnings = validateSchedulerConfig();
    expect(warnings.some(w => w.includes("SCHEDULER_HOUR"))).toBe(true);
  });

  it("returns warning for invalid minute (60)", () => {
    process.env["SCHEDULER_MINUTE"] = "60";
    const warnings = validateSchedulerConfig();
    expect(warnings.some(w => w.includes("SCHEDULER_MINUTE"))).toBe(true);
  });

  it("returns warning for invalid IANA timezone", () => {
    process.env["APP_TIMEZONE"] = "Not/A/Timezone";
    const warnings = validateSchedulerConfig();
    expect(warnings.some(w => w.includes("APP_TIMEZONE"))).toBe(true);
  });
});

// ─── scanDueServices — past target date does not trigger repeated research ────

describe("scanDueServices — past target dates do not queue research", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.select).mockImplementation(() => makeChain([]));
    vi.mocked(db.insert).mockImplementation(() => makeChain([]));
    vi.mocked(db.update).mockImplementation(() => makeChain([]));
  });

  it("does not queue research for a service whose renewal date has passed by more than the window", async () => {
    // Service with renewal 3 years ago and 60-day window — needsResearch should be false.
    // We verify scanDueServices doesn't call insert (no job is queued).
    const { scanDueServices } = await import("../src/lib/research-service");

    const pastService = {
      id: 1,
      active: true,
      autoResearch: true,
      renewalDate: new Date("2023-01-01").toISOString().slice(0, 10),
      contractEndDate: null,
      researchWindowDays: 60,
      nextResearchAt: null,
      lastResearchedAt: null,
      serviceType: "Broadband",
      monthlyCostPence: null,
      annualCostPence: null,
    };

    vi.mocked(db.select).mockImplementationOnce(() => makeChain([pastService]));

    await scanDueServices();
    // No insert should have been called — past target date means needsResearch=false
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});

// ─── heartbeat columns — DB schema inclusion ─────────────────────────────────

describe("DB schema — worker queue columns", () => {
  it("researchRunsTable includes heartbeatAt, retryCount, maxRetries, queuedAt, claimedAt", async () => {
    const { researchRunsTable } = await import("@workspace/db");
    const cols = Object.keys(researchRunsTable);
    expect(cols).toContain("heartbeatAt");
    expect(cols).toContain("retryCount");
    expect(cols).toContain("maxRetries");
    expect(cols).toContain("queuedAt");
    expect(cols).toContain("claimedAt");
  });
});

// ─── recoverStaleJobs — heartbeat-based stale detection ──────────────────────

describe("recoverStaleJobs — heartbeat-based recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.select).mockImplementation(() => makeChain([]));
    vi.mocked(db.insert).mockImplementation(() => makeChain([]));
    vi.mocked(db.update).mockImplementation(() => makeChain([]));
  });

  it("requeues a stale job when service autoResearch=true and retryCount < maxRetries", async () => {
    const { recoverStaleJobs } = await import("../src/lib/stale-jobs");
    const { executeResearch } = await import("../src/lib/research-service");

    const staleRun = {
      id: 10,
      serviceId: 1,
      status: "running",
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago — stale
      retryCount: 0,
      maxRetries: 2,
    };
    const service = { id: 1, active: true, autoResearch: true };

    // First select: stale running jobs
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([staleRun]));
    // Second select: service lookup
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([service]));

    // Mock executeResearch to avoid real OpenAI calls
    vi.mock("../src/lib/research-service", async (importOriginal) => {
      const mod = await importOriginal() as Record<string, unknown>;
      return { ...mod, executeResearch: vi.fn().mockResolvedValue(undefined) };
    });

    await recoverStaleJobs();

    // Update was called to requeue the job
    expect(vi.mocked(db.update)).toHaveBeenCalled();
  });

  it("permanently fails a job when retryCount >= maxRetries", async () => {
    const { recoverStaleJobs } = await import("../src/lib/stale-jobs");

    const exhaustedRun = {
      id: 11,
      serviceId: 2,
      status: "running",
      heartbeatAt: new Date(Date.now() - 10 * 60 * 1000), // stale
      retryCount: 2, // at limit
      maxRetries: 2,
    };

    vi.mocked(db.select).mockImplementationOnce(() => makeChain([exhaustedRun]));
    vi.mocked(db.select).mockImplementationOnce(() => makeChain([])); // service lookup — irrelevant

    await recoverStaleJobs();

    // Should update to failed status
    expect(vi.mocked(db.update)).toHaveBeenCalled();
  });

  it("no-ops when there are no stale running jobs", async () => {
    const { recoverStaleJobs } = await import("../src/lib/stale-jobs");

    vi.mocked(db.select).mockImplementationOnce(() => makeChain([])); // no stale runs

    await recoverStaleJobs();
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
  });
});

// ─── Prompt payload privacy — filtered profile + buildComparisonBasedOn ──────
//
// These tests verify the full chain: filterProfileForService → filtered profile
// → buildComparisonBasedOn → no cross-service fields leak into the prompt payload.
// This is the key privacy guarantee of the per-service allowlist system.

describe("Prompt payload privacy — cross-service fields excluded from prompt", () => {
  // Full household profile with fields from every service domain
  const sensitiveFullProfile = {
    postcode: "SW1A 1AA",
    numAdults: 2,
    numChildren: 1,
    smoker: true,               // Life insurance only
    carMake: "Tesla",           // Car insurance only
    carModel: "Model 3",        // Car insurance only
    carYear: 2023,              // Car insurance only
    annualMileage: 12000,       // Car insurance only
    claimsLast5Years: 1,        // Car insurance only
    carValuePence: 3500000,     // Car insurance only
    annualElectricityKwh: 3100, // Energy only
    annualGasKwh: 12000,        // Energy only
    heatingType: "gas",         // Energy only
    hasEv: true,                // Energy only
    hasSolar: false,
    propertyType: "detached",   // Home insurance only
    tenure: "owned",            // Home insurance only
    bedrooms: 4,                // Home insurance only
  };

  it("broadband comparison_based_on excludes smoker status, vehicle, claims", async () => {
    const { buildComparisonBasedOn } = await import("../src/lib/completeness");
    const { filterProfileForService } = await import("../src/lib/research-service");

    const filtered = filterProfileForService(sensitiveFullProfile, "Broadband");
    const comparisonBasedOn = buildComparisonBasedOn(filtered, {}, {}, "Broadband");

    // Only permitted broadband fields should appear
    const joined = comparisonBasedOn.join("\n");
    expect(joined).toContain("SW1A 1AA"); // postcode is allowed
    // Must NOT include cross-service sensitive data
    expect(joined).not.toMatch(/smoker/i);
    expect(joined).not.toMatch(/Tesla|Model 3/i);
    expect(joined).not.toMatch(/claims/i);
    expect(joined).not.toMatch(/mileage/i);
    expect(joined).not.toMatch(/kWh/i);    // energy data not in broadband allowlist
    expect(joined).not.toMatch(/gas/i);
  });

  it("car insurance comparison_based_on includes vehicle and claims — not smoker or energy", async () => {
    const { buildComparisonBasedOn } = await import("../src/lib/completeness");
    const { filterProfileForService } = await import("../src/lib/research-service");

    const filtered = filterProfileForService(sensitiveFullProfile, "Car insurance");
    const comparisonBasedOn = buildComparisonBasedOn(filtered, {}, {}, "Car insurance");

    const joined = comparisonBasedOn.join("\n");
    // Car fields are permitted
    expect(joined).toMatch(/Tesla|Model 3/i);
    expect(joined).toMatch(/claims/i);
    expect(joined).toMatch(/mileage/i);
    // Smoker and energy data must not appear
    expect(joined).not.toMatch(/smoker/i);
    expect(joined).not.toMatch(/kWh/i);
  });

  it("electricity comparison_based_on includes EV and kWh — not smoker or vehicle", async () => {
    const { buildComparisonBasedOn } = await import("../src/lib/completeness");
    const { filterProfileForService } = await import("../src/lib/research-service");

    const filtered = filterProfileForService(sensitiveFullProfile, "Electricity");
    const comparisonBasedOn = buildComparisonBasedOn(filtered, {}, {}, "Electricity");

    const joined = comparisonBasedOn.join("\n");
    expect(joined).toContain("kWh");      // energy field allowed
    expect(joined).toMatch(/EV/i);        // hasEv allowed
    expect(joined).not.toMatch(/smoker/i);
    expect(joined).not.toMatch(/Tesla|Model 3/i);
    expect(joined).not.toMatch(/claims/i);
  });

  it("life insurance comparison_based_on includes smoker status — not vehicle or energy", async () => {
    const { buildComparisonBasedOn } = await import("../src/lib/completeness");
    const { filterProfileForService } = await import("../src/lib/research-service");

    const filtered = filterProfileForService(sensitiveFullProfile, "Life insurance");
    const comparisonBasedOn = buildComparisonBasedOn(filtered, {}, {}, "Life insurance");

    const joined = comparisonBasedOn.join("\n");
    expect(joined).toMatch(/smoker/i);
    expect(joined).not.toMatch(/Tesla|Model 3/i);
    expect(joined).not.toMatch(/kWh/i);
  });
});

// ─── Generic vs personalised mode ────────────────────────────────────────────

describe("filterProfileForService — generic mode reduces profile to service fields", () => {
  it("EV-related fields reach electricity prompt", () => {
    const profile = {
      hasEv: true,
      annualElectricityKwh: 4000,
      postcode: "EC1A 1BB",
      smoker: false,
      carMake: "BMW",
    };
    const filtered = filterProfileForService(profile, "Electricity");
    expect(filtered).toHaveProperty("hasEv", true);
    expect(filtered).toHaveProperty("annualElectricityKwh", 4000);
    expect(filtered).not.toHaveProperty("smoker");
    expect(filtered).not.toHaveProperty("carMake");
  });

  it("Mobile phone prompt only includes numAdults", () => {
    const profile = { numAdults: 3, smoker: true, postcode: "EC1A 1BB" };
    const filtered = filterProfileForService(profile, "Mobile phone");
    expect(filtered).toEqual({ numAdults: 3 });
  });

  it("Credit card prompt receives empty profile (no relevant fields)", () => {
    const profile = { postcode: "EC1A 1BB", numAdults: 2, smoker: false };
    const filtered = filterProfileForService(profile, "Credit card");
    // Credit card allowlist is empty — no fields allowed
    expect(filtered).toBeNull();
  });
});
