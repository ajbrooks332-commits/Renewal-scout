/**
 * Unit tests for the strict shared validation layer (Task #10).
 *
 * Covers all edge-cases listed in the spec:
 *  - String "false" rejected for boolean fields
 *  - Negative / infinite / decimal integers rejected
 *  - Impossible dates (Feb 30, month 13, etc.) rejected
 *  - Invalid UK postcodes rejected
 *  - Unknown keys rejected with a parse error (not silently discarded)
 *  - Zero / negative route IDs rejected
 *  - Valid values accepted
 */
import { describe, it, expect } from "vitest";
import {
  CalendarDate,
  SafePositiveInt,
  NonnegativeInt,
  FiniteNonnegativeNumber,
  ServiceTypeEnum,
  parseRouteId,
  StrictCreateServiceBody,
  StrictUpdateServiceBody,
  StrictUpdateHouseholdProfileBody,
  StrictUpdateServiceRequirementsBody,
} from "@workspace/api-zod";

// ── CalendarDate ──────────────────────────────────────────────────────────────

describe("CalendarDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(CalendarDate.safeParse("2026-08-11").success).toBe(true);
    expect(CalendarDate.safeParse("2024-02-29").success).toBe(true); // leap year
    expect(CalendarDate.safeParse("2000-01-01").success).toBe(true);
  });

  it("rejects impossible dates", () => {
    expect(CalendarDate.safeParse("2026-02-30").success).toBe(false); // Feb 30
    expect(CalendarDate.safeParse("2026-04-31").success).toBe(false); // Apr 31
    expect(CalendarDate.safeParse("2026-13-01").success).toBe(false); // month 13
    expect(CalendarDate.safeParse("2023-02-29").success).toBe(false); // not a leap year
  });

  it("rejects non-YYYY-MM-DD formats", () => {
    expect(CalendarDate.safeParse("11/08/2026").success).toBe(false);
    expect(CalendarDate.safeParse("2026-8-11").success).toBe(false);  // single-digit month
    expect(CalendarDate.safeParse("not-a-date").success).toBe(false);
    expect(CalendarDate.safeParse("").success).toBe(false);
    expect(CalendarDate.safeParse(20260811).success).toBe(false);     // number
  });

  it("rejects year-rollover tricks", () => {
    // 2026-00-01 — month 0 overflows JS Date but has 13 chars in wrong format
    expect(CalendarDate.safeParse("2026-00-01").success).toBe(false);
    expect(CalendarDate.safeParse("2026-01-00").success).toBe(false);
  });
});

// ── SafePositiveInt ───────────────────────────────────────────────────────────

describe("SafePositiveInt", () => {
  it("accepts positive integers", () => {
    expect(SafePositiveInt.safeParse(1).success).toBe(true);
    expect(SafePositiveInt.safeParse(9007199254740991).success).toBe(true); // MAX_SAFE_INTEGER
  });

  it("rejects zero", () => {
    expect(SafePositiveInt.safeParse(0).success).toBe(false);
  });

  it("rejects negatives", () => {
    expect(SafePositiveInt.safeParse(-1).success).toBe(false);
    expect(SafePositiveInt.safeParse(-100).success).toBe(false);
  });

  it("rejects decimals", () => {
    expect(SafePositiveInt.safeParse(1.5).success).toBe(false);
    expect(SafePositiveInt.safeParse(0.9).success).toBe(false);
  });

  it("rejects Infinity and NaN", () => {
    expect(SafePositiveInt.safeParse(Infinity).success).toBe(false);
    expect(SafePositiveInt.safeParse(-Infinity).success).toBe(false);
    expect(SafePositiveInt.safeParse(NaN).success).toBe(false);
  });

  it("rejects string '1' (not coerced)", () => {
    expect(SafePositiveInt.safeParse("1").success).toBe(false);
  });
});

// ── NonnegativeInt ────────────────────────────────────────────────────────────

describe("NonnegativeInt", () => {
  it("accepts zero and positive integers", () => {
    expect(NonnegativeInt.safeParse(0).success).toBe(true);
    expect(NonnegativeInt.safeParse(42).success).toBe(true);
  });

  it("rejects negatives", () => {
    expect(NonnegativeInt.safeParse(-1).success).toBe(false);
  });

  it("rejects decimals", () => {
    expect(NonnegativeInt.safeParse(1.1).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(NonnegativeInt.safeParse(Infinity).success).toBe(false);
  });
});

// ── FiniteNonnegativeNumber ───────────────────────────────────────────────────

describe("FiniteNonnegativeNumber", () => {
  it("accepts decimals (GBP amounts)", () => {
    expect(FiniteNonnegativeNumber.safeParse(0).success).toBe(true);
    expect(FiniteNonnegativeNumber.safeParse(45.99).success).toBe(true);
    expect(FiniteNonnegativeNumber.safeParse(1200).success).toBe(true);
  });

  it("rejects negatives", () => {
    expect(FiniteNonnegativeNumber.safeParse(-0.01).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(FiniteNonnegativeNumber.safeParse(Infinity).success).toBe(false);
    expect(FiniteNonnegativeNumber.safeParse(-Infinity).success).toBe(false);
  });
});

// ── ServiceTypeEnum ───────────────────────────────────────────────────────────

describe("ServiceTypeEnum", () => {
  it("accepts all valid service types", () => {
    const types = [
      "Broadband", "Electricity", "Gas and electricity",
      "Car insurance", "Home insurance", "Life insurance",
      "Credit card", "Loan", "Mobile phone", "Other",
    ];
    for (const t of types) {
      expect(ServiceTypeEnum.safeParse(t).success).toBe(true);
    }
  });

  it("rejects arbitrary strings", () => {
    expect(ServiceTypeEnum.safeParse("broadband").success).toBe(false); // wrong case
    expect(ServiceTypeEnum.safeParse("Internet").success).toBe(false);
    expect(ServiceTypeEnum.safeParse("").success).toBe(false);
  });
});

// ── parseRouteId ──────────────────────────────────────────────────────────────

describe("parseRouteId", () => {
  it("returns the integer for a valid positive ID string", () => {
    expect(parseRouteId("1")).toBe(1);
    expect(parseRouteId("42")).toBe(42);
    expect(parseRouteId("9007199254740991")).toBe(9007199254740991);
  });

  it("returns null for '1abc' (non-digit suffix)", () => {
    // This is the critical regression: parseInt('1abc') = 1, but parseRouteId rejects it
    expect(parseRouteId("1abc")).toBeNull();
    expect(parseRouteId("abc1")).toBeNull();
    expect(parseRouteId("1.5")).toBeNull(); // decimal dot is non-digit
  });

  it("returns null for zero", () => {
    expect(parseRouteId("0")).toBeNull();
  });

  it("returns null for negative strings", () => {
    expect(parseRouteId("-1")).toBeNull();
    expect(parseRouteId("-100")).toBeNull();
  });

  it("returns null for undefined / empty string", () => {
    expect(parseRouteId(undefined)).toBeNull();
    expect(parseRouteId("")).toBeNull();
  });
});

// ── StrictCreateServiceBody ───────────────────────────────────────────────────

describe("StrictCreateServiceBody", () => {
  const base = {
    serviceType: "Broadband",
    provider: "BT",
    noticeDays: 30,
    researchWindowDays: 60,
  };

  it("accepts a minimal valid body", () => {
    expect(StrictCreateServiceBody.safeParse(base).success).toBe(true);
  });

  it("accepts a full valid body", () => {
    const full = {
      ...base,
      productName: "Full Fibre 100",
      monthlyCostGbp: 35.99,
      annualCostGbp: 432,
      renewalDate: "2026-12-01",
      contractEndDate: "2027-01-01",
      location: "SW1A",
      currentTerms: "100Mbps",
      preferences: "No setup fee",
      quoteFacts: "3 bedroom house",
      autoResearch: true,
    };
    expect(StrictCreateServiceBody.safeParse(full).success).toBe(true);
  });

  it("rejects unknown keys (.strict())", () => {
    const withUnknown = { ...base, unknownField: "value" };
    const result = StrictCreateServiceBody.safeParse(withUnknown);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("rejects invalid serviceType (not in enum)", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, serviceType: "Plumbing" }).success).toBe(false);
    expect(StrictCreateServiceBody.safeParse({ ...base, serviceType: "broadband" }).success).toBe(false);
  });

  it("rejects negative cost values", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, monthlyCostGbp: -1 }).success).toBe(false);
    expect(StrictCreateServiceBody.safeParse({ ...base, annualCostGbp: -0.01 }).success).toBe(false);
  });

  it("rejects Infinity for cost fields", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, monthlyCostGbp: Infinity }).success).toBe(false);
  });

  it("rejects impossible dates", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, renewalDate: "2026-02-30" }).success).toBe(false);
    expect(StrictCreateServiceBody.safeParse({ ...base, contractEndDate: "2026-13-01" }).success).toBe(false);
  });

  it("rejects decimal noticeDays", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, noticeDays: 30.5 }).success).toBe(false);
  });

  it("rejects negative noticeDays", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, noticeDays: -1 }).success).toBe(false);
  });

  it("rejects provider longer than 160 chars", () => {
    expect(
      StrictCreateServiceBody.safeParse({ ...base, provider: "x".repeat(161) }).success
    ).toBe(false);
  });

  it("rejects whitespace-only provider ('   ' trims to empty string → min(1) fails)", () => {
    expect(StrictCreateServiceBody.safeParse({ ...base, provider: "   " }).success).toBe(false);
    expect(StrictCreateServiceBody.safeParse({ ...base, provider: "\t\n" }).success).toBe(false);
  });

  it("accepts provider with surrounding whitespace (trim normalises it)", () => {
    const result = StrictCreateServiceBody.safeParse({ ...base, provider: "  BT  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("BT");
    }
  });
});

// ── StrictUpdateHouseholdProfileBody ─────────────────────────────────────────

describe("StrictUpdateHouseholdProfileBody", () => {
  it("accepts an empty body (all fields optional — no keys required)", () => {
    expect(StrictUpdateHouseholdProfileBody.safeParse({}).success).toBe(true);
  });

  it("accepts a valid single-field patch", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: "SW1A 1AA" }).success
    ).toBe(true);
  });

  it("accepts null for any field (explicit clear)", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ bedrooms: null, hasEv: null }).success
    ).toBe(true);
  });

  it("rejects unknown keys (.strict())", () => {
    const result = StrictUpdateHouseholdProfileBody.safeParse({
      postcode: "SW1A 1AA",
      unknownField: "value",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });

  it("rejects string 'false' for boolean fields", () => {
    // This is the critical regression: Boolean("false") = true, but Zod strict rejects strings
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ hasEv: "false" }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ hasSolar: "true" }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ smoker: "false" }).success
    ).toBe(false);
  });

  it("rejects decimal values for integer fields", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ bedrooms: 2.5 }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ numAdults: 1.9 }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ annualMileage: 8000.5 }).success
    ).toBe(false);
  });

  it("rejects negative values for non-negative integer fields", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ bedrooms: -1 }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ numCars: -1 }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ claimsLast5Years: -1 }).success
    ).toBe(false);
  });

  it("rejects Infinity for numeric fields", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ carValue: Infinity }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ annualElectricityKwh: Infinity }).success
    ).toBe(false);
  });

  it("rejects invalid UK postcodes", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: "12345" }).success
    ).toBe(false);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: "NOTAPOSTCODE" }).success
    ).toBe(false);
  });

  it("accepts valid UK postcodes", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: "SW1A 1AA" }).success
    ).toBe(true);
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: "EC1A1BB" }).success
    ).toBe(true);
  });

  it("accepts null for postcode (explicit clear)", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ postcode: null }).success
    ).toBe(true);
  });

  it("accepts valid enum values for propertyType and tenure", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ propertyType: "flat", tenure: "owner" }).success
    ).toBe(true);
  });

  it("rejects invalid enum values for propertyType", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ propertyType: "castle" }).success
    ).toBe(false);
  });

  it("accepts valid carValue as decimal GBP", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ carValue: 15000.50 }).success
    ).toBe(true);
  });

  it("rejects negative carValue", () => {
    expect(
      StrictUpdateHouseholdProfileBody.safeParse({ carValue: -100 }).success
    ).toBe(false);
  });
});

// ── StrictUpdateServiceRequirementsBody ───────────────────────────────────────

describe("StrictUpdateServiceRequirementsBody", () => {
  it("accepts a valid fields object", () => {
    expect(
      StrictUpdateServiceRequirementsBody.safeParse({
        fields: { downloadSpeedMbps: 100, includesLineRental: true },
      }).success
    ).toBe(true);
  });

  it("accepts null values inside fields (I don't know)", () => {
    expect(
      StrictUpdateServiceRequirementsBody.safeParse({
        fields: { downloadSpeedMbps: null },
      }).success
    ).toBe(true);
  });

  it("rejects missing fields property", () => {
    expect(StrictUpdateServiceRequirementsBody.safeParse({}).success).toBe(false);
    expect(StrictUpdateServiceRequirementsBody.safeParse({ notFields: {} }).success).toBe(false);
  });

  it("rejects unknown top-level keys (.strict())", () => {
    const result = StrictUpdateServiceRequirementsBody.safeParse({
      fields: {},
      unknownKey: "value",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
    }
  });
});
