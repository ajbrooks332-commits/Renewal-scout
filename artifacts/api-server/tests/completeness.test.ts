/**
 * Unit tests for the completeness check module.
 *
 * Tests cover:
 *  - Service-specific required/recommended fields (broadband ≠ car fields)
 *  - unknownFields exclusion from blocking (profile + requirements)
 *  - researchMode derivation (personalised vs generic)
 *  - Provider-only cost does NOT satisfy confirmed-cost check
 *  - Multi-vehicle data reflected in buildComparisonBasedOn
 *  - Requirements field semantics: absent = missing, null present = "I don't know"
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock @workspace/db ───────────────────────────────────────────────────────
// We mock the db module so completeness.ts doesn't hit a real database.
// The makeChain helper mirrors the pattern used in task5.test.ts so that
// every chain node is a proper thenable (routes may await at .where() or
// .limit(), whichever comes last).

vi.mock("@workspace/db", async () => {
  const { vi } = await import("vitest");
  return {
    db: { select: vi.fn() },
    servicesTable: { id: "services.id" },
    householdProfileTable: { id: "hp.id" },
    serviceRequirementsTable: { serviceId: "sr.serviceId" },
    currentDealsTable: { serviceId: "cd.serviceId" },
  };
});

// Drizzle's `eq` is used in where() but doesn't need real SQL; just mock it.
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain<T>(resolveWith: T): any {
  const resolved = Promise.resolve(resolveWith);
  const chain: Record<string, unknown> = {
    from:   () => chain,
    where:  () => chain,
    limit:  () => resolved,
    then:   (f?: (v: T) => unknown, r?: (e: unknown) => unknown) => resolved.then(f, r),
    catch:  (r?: (e: unknown) => unknown) => resolved.catch(r),
    finally:(f?: () => void) => resolved.finally(f),
  };
  return chain;
}

// ─── Imports (after mocks are set up) ────────────────────────────────────────

const { checkCompleteness, buildComparisonBasedOn } = await import(
  "../src/lib/completeness"
);
const { db } = await import("@workspace/db");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDb_returns(
  service: unknown,
  profile: unknown,
  reqRow: unknown,
  dealRow: unknown,
) {
  const rows = [[service], [profile], [reqRow], [dealRow]];
  rows.forEach((r) => {
    vi.mocked(db.select).mockReturnValueOnce(makeChain(r));
  });
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

const BASE_PROFILE = {
  postcode: "SW1A 1AA",
  propertyType: "flat",
  tenure: "tenant",
  bedrooms: 2,
  yearBuilt: 1990,
  numAdults: 2,
  numChildren: 0,
  heatingType: "gas",
  hasEv: false,
  hasSolar: false,
  annualElectricityKwh: 3500,
  annualGasKwh: 12000,
  numCars: 1,
  carMake: "Ford",
  carModel: "Focus",
  carYear: 2019,
  carValuePence: 800000,
  annualMileage: 8000,
  drivingExperience: "5_10yrs",
  claimsLast5Years: 0,
  smoker: false,
  unknownFields: [],
  vehicles: [],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("checkCompleteness — broadband service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns personalised when postcode is present", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.blocking).toBe(false);
    expect(report.researchMode).toBe("personalised");
    expect(report.required).toHaveLength(0);
  });

  it("blocks when postcode is missing", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: null, unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.blocking).toBe(true);
    expect(report.researchMode).toBe("generic");
    expect(report.required[0]).toMatchObject({ label: "Postcode", destination: "household" });
  });

  it("does NOT report car or smoker fields as missing for Broadband", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", carMake: null, smoker: null, unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    const labels = [...report.required, ...report.recommended].map((f) => f.label);
    expect(labels).not.toContain("Car make");
    expect(labels).not.toContain("Smoker status");
  });

  it("includes postcode in recommended fields with 'household' destination", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: null, unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    // postcode is required for Broadband
    expect(report.required.find((f) => f.label === "Postcode")?.destination).toBe("household");
  });
});

describe("checkCompleteness — car insurance service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires carMake, carModel, carYear, and coverType", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: null, carModel: null, carYear: null, unknownFields: [], vehicles: [] },
      {},     // requirements with no coverType
      null,
    );
    const report = await checkCompleteness(1);
    const requiredLabels = report.required.map((f) => f.label);
    expect(requiredLabels).toContain("Car make");
    expect(requiredLabels).toContain("Car model");
    expect(requiredLabels).toContain("Car year");
    expect(requiredLabels).toContain("Cover type");
    expect(report.blocking).toBe(true);
  });

  it("does NOT block when all required car fields are present", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: "Ford", carModel: "Focus", carYear: 2019, unknownFields: [], vehicles: [] },
      { fields: { coverType: "comprehensive" } },  // coverType key present with value
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.blocking).toBe(false);
    expect(report.researchMode).toBe("personalised");
  });

  it("does NOT report broadband-specific fields as missing", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { ...BASE_PROFILE, carMake: null },
      { fields: { coverType: "comprehensive" } },
      null,
    );
    const report = await checkCompleteness(1);
    const labels = [...report.required, ...report.recommended].map((f) => f.label);
    expect(labels).not.toContain("Min. download speed (Mbps)");
    expect(labels).not.toContain("Number of adults (usage estimate)");
  });
});

describe("checkCompleteness — unknownFields exclusion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("excludes car fields from blocking when user acknowledged them as unknown", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      // carMake and carModel are null but in unknownFields
      { postcode: "SW1A 1AA", carMake: null, carModel: null, carYear: 2019, unknownFields: ["carMake", "carModel"], vehicles: [] },
      { fields: { coverType: "comprehensive" } },
      null,
    );
    const report = await checkCompleteness(1);
    const requiredLabels = report.required.map((f) => f.label);
    expect(requiredLabels).not.toContain("Car make");
    expect(requiredLabels).not.toContain("Car model");
    // carYear is present, coverType is present, so not blocking
    expect(report.blocking).toBe(false);
    expect(report.researchMode).toBe("personalised");
  });

  it("still blocks if field is null AND not in unknownFields", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: null, carModel: "Focus", carYear: 2019, unknownFields: [], vehicles: [] },
      { fields: { coverType: "comprehensive" } },
      null,
    );
    const report = await checkCompleteness(1);
    const requiredLabels = report.required.map((f) => f.label);
    expect(requiredLabels).toContain("Car make");
    expect(report.blocking).toBe(true);
  });
});

describe("checkCompleteness — requirements answer-state semantics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats absent key as missing (blocking)", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: "Ford", carModel: "Focus", carYear: 2019, unknownFields: [], vehicles: [] },
      { fields: {} },  // coverType key entirely absent → missing
      null,
    );
    const report = await checkCompleteness(1);
    const requiredLabels = report.required.map((f) => f.label);
    expect(requiredLabels).toContain("Cover type");
    expect(report.blocking).toBe(true);
  });

  it("treats present key with null as NOT missing (explicit 'I don't know')", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: "Ford", carModel: "Focus", carYear: 2019, unknownFields: [], vehicles: [] },
      { fields: { coverType: null } },  // key present with null → acknowledged unknown, not blocking
      null,
    );
    const report = await checkCompleteness(1);
    const requiredLabels = report.required.map((f) => f.label);
    expect(requiredLabels).not.toContain("Cover type");
    expect(report.blocking).toBe(false);
  });

  it("treats present key with value as answered (not missing)", async () => {
    mockDb_returns(
      { serviceType: "Car insurance" },
      { postcode: "SW1A 1AA", carMake: "Ford", carModel: "Focus", carYear: 2019, unknownFields: [], vehicles: [] },
      { fields: { coverType: "comprehensive" } },
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.required.map((f) => f.label)).not.toContain("Cover type");
    expect(report.blocking).toBe(false);
  });
});

describe("checkCompleteness — optional confirmed cost (provider-only excluded)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("flags optional cost hint when no confirmed cost exists", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", unknownFields: [], vehicles: [] },
      null,
      null, // no deal row
    );
    const report = await checkCompleteness(1);
    expect(report.optional.some((o) => o.includes("cost"))).toBe(true);
  });

  it("does NOT flag optional cost hint when confirmed cost exists", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", unknownFields: [], vehicles: [] },
      null,
      { fields: { monthlyCostGbp: { value: 29.99, source: "user" } } },
    );
    const report = await checkCompleteness(1);
    expect(report.optional.some((o) => o.includes("cost"))).toBe(false);
  });

  it("DOES flag optional cost hint when only provider name is confirmed (not a cost field)", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", unknownFields: [], vehicles: [] },
      null,
      { fields: { provider: { value: "BT", source: "user" } } }, // provider only
    );
    const report = await checkCompleteness(1);
    expect(report.optional.some((o) => o.includes("cost"))).toBe(true);
  });
});

describe("checkCompleteness — researchMode derivation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns personalised when no required fields are missing", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: "SW1A 1AA", unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.researchMode).toBe("personalised");
    expect(report.blocking).toBe(false);
  });

  it("returns generic when required fields are missing", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      { postcode: null, unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.researchMode).toBe("generic");
    expect(report.blocking).toBe(true);
  });

  it("returns personalised even when recommended fields are missing", async () => {
    mockDb_returns(
      { serviceType: "Broadband" },
      // postcode present but numAdults missing
      { postcode: "SW1A 1AA", numAdults: null, unknownFields: [], vehicles: [] },
      null,
      null,
    );
    const report = await checkCompleteness(1);
    expect(report.researchMode).toBe("personalised");
    expect(report.blocking).toBe(false);
    expect(report.recommended.length).toBeGreaterThan(0);
  });
});

describe("buildComparisonBasedOn — multi-vehicle and provider-only exclusion", () => {
  it("includes vehicle from vehicles array", () => {
    const items = buildComparisonBasedOn(
      {
        vehicles: [
          { make: "Tesla", model: "Model 3", year: 2022, annualMileage: 12000 },
        ],
      },
      {},
      {},
      "Car insurance",
    );
    expect(items.some((s) => s.includes("Tesla Model 3"))).toBe(true);
  });

  it("labels multiple vehicles", () => {
    const items = buildComparisonBasedOn(
      {
        vehicles: [
          { make: "Ford", model: "Focus", year: 2019 },
          { make: "BMW", model: "3 Series", year: 2021 },
        ],
      },
      {},
      {},
      "Car insurance",
    );
    expect(items.some((s) => s.includes("Vehicle 1"))).toBe(true);
    expect(items.some((s) => s.includes("Vehicle 2"))).toBe(true);
  });

  it("excludes provider from confirmed cost summary", () => {
    const items = buildComparisonBasedOn(
      null,
      {},
      { provider: { value: "BT", source: "user" } },
      "Broadband",
    );
    // provider should NOT appear in "Current deal cost:" line
    expect(items.some((s) => s.startsWith("Current deal cost:"))).toBe(false);
  });

  it("includes monetary confirmed cost in summary", () => {
    const items = buildComparisonBasedOn(
      null,
      {},
      { monthlyCostGbp: { value: 29.99, source: "user" } },
      "Broadband",
    );
    expect(items.some((s) => s.includes("Current deal cost:"))).toBe(true);
  });

  it("falls back to legacy single-car fields when vehicles array is empty", () => {
    const items = buildComparisonBasedOn(
      { vehicles: [], carMake: "Ford", carModel: "Focus", carYear: 2019 },
      {},
      {},
      "Car insurance",
    );
    expect(items.some((s) => s.includes("Ford Focus"))).toBe(true);
  });
});
