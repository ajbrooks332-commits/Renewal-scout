/**
 * Completeness check: given a service ID, determines which deal-supporting
 * data fields are missing and whether the gap is blocking or advisory.
 *
 * Checks are service-type specific — broadband completeness never reports
 * missing car or smoker fields; energy completeness never reports broadband fields.
 *
 * Each missing field is tagged with a `destination` so the UI can navigate
 * the user directly to the right page/tab:
 *   "household"    → /household profile page
 *   "requirements" → service detail, Requirements tab
 *   "current-deal" → service detail, Current Deal tab
 *
 * Answer-state semantics:
 *   - Profile field: null AND key NOT in unknownFields → unanswered (counts as missing)
 *   - Profile field: null AND key in unknownFields    → "I don't know" (not missing)
 *   - Requirements field: key absent from fields object → unanswered (missing)
 *   - Requirements field: key present with null value   → "I don't know" (not missing)
 *
 * Research modes:
 *   "personalised" — all required fields are supplied; AI can personalise results.
 *   "generic"      — some required fields are missing; results are non-personalised
 *                    public examples with a disclaimer.
 */
import { eq } from "drizzle-orm";
import {
  db,
  servicesTable,
  householdProfileTable,
  serviceRequirementsTable,
  currentDealsTable,
} from "@workspace/db";
import type { MissingField, CompletenessReport } from "@workspace/api-zod";

export type { MissingField, CompletenessReport };

// ─── Field descriptor ─────────────────────────────────────────────────────────

type FieldGroup = {
  label: string;
  /** Where the value lives in the data model. */
  source: "profile" | "requirements";
  /** DB column name (profile) or JSONB key (requirements). */
  key: string;
  /** Which UI tab/page to navigate to fix this field. */
  destination: "household" | "requirements";
};

// ─── Service-type specific required fields ────────────────────────────────────

const REQUIRED_FIELDS: Record<string, FieldGroup[]> = {
  "Car insurance": [
    { label: "Car make",   source: "profile",      key: "carMake",       destination: "household" },
    { label: "Car model",  source: "profile",      key: "carModel",      destination: "household" },
    { label: "Car year",   source: "profile",      key: "carYear",       destination: "household" },
    { label: "Cover type", source: "requirements", key: "coverType",     destination: "requirements" },
  ],
  "Home insurance": [
    { label: "Postcode",          source: "profile", key: "postcode",      destination: "household" },
    { label: "Property type",     source: "profile", key: "propertyType",  destination: "household" },
    { label: "Tenure (owner/tenant)", source: "profile", key: "tenure",    destination: "household" },
    { label: "Number of bedrooms",    source: "profile", key: "bedrooms",  destination: "household" },
    { label: "Cover type",        source: "requirements", key: "coverType", destination: "requirements" },
  ],
  Broadband: [
    { label: "Postcode", source: "profile", key: "postcode", destination: "household" },
  ],
  Electricity: [
    { label: "Postcode", source: "profile", key: "postcode", destination: "household" },
  ],
  "Gas and electricity": [
    { label: "Postcode", source: "profile", key: "postcode", destination: "household" },
  ],
  "Life insurance": [
    { label: "Number of adults in household", source: "profile", key: "numAdults", destination: "household" },
  ],
  "Mobile phone": [],
  "Credit card": [],
  Loan: [],
};

// ─── Service-type specific recommended fields ─────────────────────────────────

const RECOMMENDED_FIELDS: Record<string, FieldGroup[]> = {
  "Car insurance": [
    { label: "Annual mileage",         source: "profile", key: "annualMileage",      destination: "household" },
    { label: "Driving experience",     source: "profile", key: "drivingExperience",  destination: "household" },
    { label: "At-fault claims (5 yr)", source: "profile", key: "claimsLast5Years",  destination: "household" },
    { label: "Car value (£)",          source: "profile", key: "carValuePence",      destination: "household" },
    { label: "Postcode",               source: "profile", key: "postcode",           destination: "household" },
  ],
  "Home insurance": [
    { label: "Year built",                  source: "profile",       key: "yearBuilt",          destination: "household" },
    { label: "Number of adults",            source: "profile",       key: "numAdults",           destination: "household" },
    { label: "Rebuild value (£)",           source: "requirements",  key: "rebuildValueGbp",     destination: "requirements" },
    { label: "Contents value (£)",          source: "requirements",  key: "contentsValueGbp",    destination: "requirements" },
  ],
  Electricity: [
    { label: "Annual electricity usage (kWh)", source: "profile",      key: "annualElectricityKwh", destination: "household" },
    { label: "Heating type",                   source: "profile",      key: "heatingType",          destination: "household" },
    { label: "Tariff preference",              source: "requirements", key: "tariffType",            destination: "requirements" },
  ],
  "Gas and electricity": [
    { label: "Annual electricity usage (kWh)", source: "profile",      key: "annualElectricityKwh", destination: "household" },
    { label: "Annual gas usage (kWh)",         source: "profile",      key: "annualGasKwh",          destination: "household" },
    { label: "Heating type",                   source: "profile",      key: "heatingType",           destination: "household" },
    { label: "Tariff preference",              source: "requirements", key: "tariffType",             destination: "requirements" },
  ],
  "Life insurance": [
    { label: "Smoker status",               source: "profile",      key: "smoker",           destination: "household" },
    { label: "Cover type",                  source: "requirements", key: "coverType",         destination: "requirements" },
    { label: "Cover term (years)",          source: "requirements", key: "termYears",         destination: "requirements" },
  ],
  Broadband: [
    { label: "Number of adults (usage estimate)", source: "profile",      key: "numAdults",          destination: "household" },
    { label: "Min. download speed (Mbps)",        source: "requirements", key: "downloadSpeedMbps",  destination: "requirements" },
  ],
  "Mobile phone": [
    { label: "Minimum data per month (GB)", source: "requirements", key: "monthlyDataGb",    destination: "requirements" },
  ],
  "Credit card": [
    { label: "Primary use",                source: "requirements", key: "primaryUse",        destination: "requirements" },
  ],
  Loan: [
    { label: "Loan purpose",              source: "requirements", key: "purposeOfLoan",      destination: "requirements" },
    { label: "Loan amount (£)",           source: "requirements", key: "amountGbp",          destination: "requirements" },
  ],
};

// ─── Cost field keys (provider-only does NOT count as confirmed cost) ─────────

const CONFIRMED_COST_KEYS = new Set([
  "monthlyCostGbp",
  "annualCostGbp",
  "monthlyPremiumGbp",
  "annualPremiumGbp",
  "monthlyBudgetGbp",
]);

// ─── Main check ───────────────────────────────────────────────────────────────

export async function checkCompleteness(
  serviceId: number,
): Promise<CompletenessReport> {
  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId));

  const [profile] = await db
    .select()
    .from(householdProfileTable)
    .limit(1);

  const [reqRow] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, serviceId));

  const [dealRow] = await db
    .select()
    .from(currentDealsTable)
    .where(eq(currentDealsTable.serviceId, serviceId));

  const serviceType = service?.serviceType ?? "Other";
  const profileData = (profile ?? {}) as Record<string, unknown>;

  // Fields where user explicitly said "I don't know" — these are NOT missing.
  const profileUnknownFields = new Set<string>(
    Array.isArray(profile?.unknownFields)
      ? (profile.unknownFields as unknown[]).filter((v): v is string => typeof v === "string")
      : [],
  );

  // Service requirements: JSONB fields object. Key presence = answered/explicitly-unknown.
  // Key absent from object = unanswered (missing).
  const reqFields = (reqRow?.fields ?? {}) as Record<string, unknown>;

  // Current deal fields — only confirmed cost (not provider name) satisfies cost check.
  const dealFields = (dealRow?.fields ?? {}) as Record<
    string,
    { value: unknown; source: string }
  >;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function isProfileFieldMissing(key: string): boolean {
    const v = profileData[key];
    const absent = v === null || v === undefined || v === "";
    if (!absent) return false;
    // Explicitly acknowledged as unknown → not blocking
    return !profileUnknownFields.has(key);
  }

  function isRequirementMissing(key: string): boolean {
    // Key absent from reqFields entirely → unanswered (missing)
    // Key present (even with null) → answered or explicit don't know (not missing)
    return !(key in reqFields);
  }

  function isMissing(group: FieldGroup): boolean {
    if (group.source === "profile") return isProfileFieldMissing(group.key);
    return isRequirementMissing(group.key);
  }

  // ── Per-service-type check ────────────────────────────────────────────────

  const requiredGroups  = REQUIRED_FIELDS[serviceType]  ?? [];
  const recommendedGroups = RECOMMENDED_FIELDS[serviceType] ?? [];

  const missingRequired: MissingField[] = requiredGroups
    .filter(isMissing)
    .map((g) => ({ label: g.label, destination: g.destination }));

  const missingRecommended: MissingField[] = recommendedGroups
    .filter(isMissing)
    .map((g) => ({ label: g.label, destination: g.destination }));

  // ── Optional: confirmed cost (excluding provider-name-only) ──────────────
  const optional: string[] = [];
  const hasConfirmedCost = Object.entries(dealFields).some(
    ([k, pf]) =>
      CONFIRMED_COST_KEYS.has(k) &&
      (pf.source === "user" || pf.source === "extracted_confirmed") &&
      pf.value !== null &&
      pf.value !== undefined,
  );
  if (!hasConfirmedCost) {
    optional.push(
      "Current deal cost (helps AI quantify potential savings vs your existing deal)",
    );
  }

  const blocking = missingRequired.length > 0;

  return {
    required:     missingRequired,
    recommended:  missingRecommended,
    optional,
    blocking,
    researchMode: blocking ? "generic" : "personalised",
  };
}

/**
 * Build a human-readable list of what data WAS available for the research
 * prompt. Used for the "Comparison based on" report section.
 *
 * Provider name alone does NOT count as confirmed cost information.
 */
export function buildComparisonBasedOn(
  profile: Record<string, unknown> | null,
  reqFields: Record<string, unknown>,
  dealFields: Record<string, { value: unknown; source: string }>,
  serviceType: string,
): string[] {
  const items: string[] = [];
  void serviceType; // reserved for future service-specific filtering

  if (profile) {
    if (profile["postcode"]) items.push(`Postcode: ${profile["postcode"]}`);
    if (profile["propertyType"]) {
      items.push(`Property: ${profile["propertyType"]} (${profile["tenure"] ?? "unknown tenure"})`);
    }
    if (profile["bedrooms"]) items.push(`Bedrooms: ${profile["bedrooms"]}`);
    if (profile["numAdults"] !== null && profile["numAdults"] !== undefined)
      items.push(`${profile["numAdults"]} adult(s) in household`);
    if (profile["numChildren"]) items.push(`${profile["numChildren"]} child(ren)`);
    if (profile["heatingType"]) items.push(`Heating: ${profile["heatingType"]}`);
    if (profile["annualElectricityKwh"])
      items.push(`Electricity: ${profile["annualElectricityKwh"]} kWh/year`);
    if (profile["annualGasKwh"]) items.push(`Gas: ${profile["annualGasKwh"]} kWh/year`);
    if (profile["hasEv"]) items.push("EV owner");
    if (profile["hasSolar"]) items.push("Solar panels");

    // Multi-vehicle: prefer vehicles array, fall back to single-car columns
    const vehicles = Array.isArray(profile["vehicles"])
      ? (profile["vehicles"] as Record<string, unknown>[])
      : [];
    if (vehicles.length > 0) {
      vehicles.forEach((v, i) => {
        const label = vehicles.length > 1 ? `Vehicle ${i + 1}` : "Vehicle";
        items.push(`${label}: ${v["make"] ?? ""} ${v["model"] ?? ""} (${v["year"] ?? "year unknown"})`);
        if (v["annualMileage"]) items.push(`  Mileage: ${v["annualMileage"]}`);
      });
    } else if (profile["carMake"] && profile["carModel"]) {
      items.push(
        `Vehicle: ${profile["carMake"]} ${profile["carModel"]} (${profile["carYear"] ?? "year unknown"})`,
      );
      if (profile["annualMileage"]) items.push(`Annual mileage: ${profile["annualMileage"]}`);
    }

    if (
      profile["claimsLast5Years"] !== null &&
      profile["claimsLast5Years"] !== undefined
    ) {
      items.push(`Claims in last 5 years: ${profile["claimsLast5Years"]}`);
    }
    if (typeof profile["smoker"] === "boolean")
      items.push(profile["smoker"] ? "Smoker" : "Non-smoker");
  }

  // Confirmed current deal cost — provider name excluded (not cost info)
  const confirmedCostParts = Object.entries(dealFields)
    .filter(
      ([k, pf]) =>
        CONFIRMED_COST_KEYS.has(k) &&
        (pf.source === "user" || pf.source === "extracted_confirmed") &&
        pf.value !== null,
    )
    .map(([k, pf]) => `${k}: ${pf.value}`);
  if (confirmedCostParts.length > 0)
    items.push(`Current deal cost: ${confirmedCostParts.join(", ")}`);

  // Requirements
  const reqSummary = Object.entries(reqFields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  if (reqSummary) items.push(`Requirements: ${reqSummary}`);

  if (items.length === 0)
    items.push(
      "No household profile or deal data provided — research based on service details only",
    );

  return items;
}
