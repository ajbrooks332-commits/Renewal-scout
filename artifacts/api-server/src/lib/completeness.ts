/**
 * Completeness check: given a service ID, determines which deal-supporting
 * data fields are missing and whether the gap is blocking or advisory.
 *
 * "Required" fields — missing ones block research (422) unless forceWithMissing.
 * "Recommended" fields — missing ones show a dismissable warning.
 * "Optional" fields — surfaced in the report's missing_information list.
 */
import { eq } from "drizzle-orm";
import {
  db,
  servicesTable,
  householdProfileTable,
  serviceRequirementsTable,
  currentDealsTable,
} from "@workspace/db";

export interface CompletenessReport {
  required: string[];
  recommended: string[];
  optional: string[];
  blocking: boolean;
}

// ─── Per-service-type field requirements ─────────────────────────────────────

type FieldGroup = {
  label: string;
  source: "profile" | "requirements";
  key: string;
};

const REQUIRED_FIELDS: Record<string, FieldGroup[]> = {
  "Car insurance": [
    { label: "Car make", source: "profile", key: "carMake" },
    { label: "Car model", source: "profile", key: "carModel" },
    { label: "Car year", source: "profile", key: "carYear" },
  ],
  "Home insurance": [
    { label: "Postcode", source: "profile", key: "postcode" },
    { label: "Property type", source: "profile", key: "propertyType" },
    { label: "Tenure (owner/tenant)", source: "profile", key: "tenure" },
    { label: "Number of bedrooms", source: "profile", key: "bedrooms" },
  ],
  Broadband: [
    { label: "Postcode", source: "profile", key: "postcode" },
  ],
  Electricity: [
    { label: "Postcode", source: "profile", key: "postcode" },
  ],
  "Gas and electricity": [
    { label: "Postcode", source: "profile", key: "postcode" },
  ],
};

const RECOMMENDED_FIELDS: Record<string, FieldGroup[]> = {
  "Car insurance": [
    { label: "Annual mileage", source: "profile", key: "annualMileage" },
    { label: "Driving experience", source: "profile", key: "drivingExperience" },
    { label: "Claims in last 5 years", source: "profile", key: "claimsLast5Years" },
    { label: "Car value (£)", source: "profile", key: "carValue" },
  ],
  "Home insurance": [
    { label: "Year built", source: "profile", key: "yearBuilt" },
  ],
  Electricity: [
    { label: "Annual electricity usage (kWh)", source: "profile", key: "annualElectricityKwh" },
    { label: "Heating type", source: "profile", key: "heatingType" },
  ],
  "Gas and electricity": [
    { label: "Annual electricity usage (kWh)", source: "profile", key: "annualElectricityKwh" },
    { label: "Annual gas usage (kWh)", source: "profile", key: "annualGasKwh" },
    { label: "Heating type", source: "profile", key: "heatingType" },
  ],
  "Life insurance": [
    { label: "Number of adults in household", source: "profile", key: "numAdults" },
    { label: "Smoker status", source: "profile", key: "smoker" },
  ],
  Broadband: [
    { label: "Number of adults (to estimate usage)", source: "profile", key: "numAdults" },
  ],
};

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
  const reqFields = (reqRow?.fields ?? {}) as Record<string, unknown>;
  const dealFields = (dealRow?.fields ?? {}) as Record<string, { value: unknown; source: string }>;

  function isMissing(group: FieldGroup): boolean {
    if (group.source === "profile") {
      const v = profileData[group.key];
      return v === null || v === undefined;
    }
    if (group.source === "requirements") {
      const v = reqFields[group.key];
      return v === null || v === undefined;
    }
    return false;
  }

  const requiredGroups = REQUIRED_FIELDS[serviceType] ?? [];
  const recommendedGroups = RECOMMENDED_FIELDS[serviceType] ?? [];

  const missingRequired = requiredGroups
    .filter(isMissing)
    .map((g) => g.label);

  const missingRecommended = recommendedGroups
    .filter(isMissing)
    .map((g) => g.label);

  // Optional: check if current deal has any confirmed cost info
  const optional: string[] = [];
  const hasConfirmedCost = Object.values(dealFields).some(
    (pf) =>
      (pf.source === "user" || pf.source === "extracted_confirmed") &&
      pf.value !== null &&
      pf.value !== undefined,
  );
  if (!hasConfirmedCost) {
    optional.push("Current deal details (helps AI compare against your existing deal)");
  }

  return {
    required: missingRequired,
    recommended: missingRecommended,
    optional,
    blocking: missingRequired.length > 0,
  };
}

/**
 * Build a summary of what data WAS available for the research prompt.
 * Used for the "Comparison based on" report section.
 */
export function buildComparisonBasedOn(
  profile: Record<string, unknown> | null,
  reqFields: Record<string, unknown>,
  dealFields: Record<string, { value: unknown; source: string }>,
  serviceType: string,
): string[] {
  const items: string[] = [];

  if (profile) {
    if (profile["postcode"]) items.push(`Postcode: ${profile["postcode"]}`);
    if (profile["propertyType"]) items.push(`Property: ${profile["propertyType"]} (${profile["tenure"] ?? "unknown tenure"})`);
    if (profile["bedrooms"]) items.push(`Bedrooms: ${profile["bedrooms"]}`);
    if (profile["numAdults"] !== null && profile["numAdults"] !== undefined) items.push(`${profile["numAdults"]} adult(s) in household`);
    if (profile["numChildren"]) items.push(`${profile["numChildren"]} child(ren)`);
    if (profile["heatingType"]) items.push(`Heating: ${profile["heatingType"]}`);
    if (profile["annualElectricityKwh"]) items.push(`Electricity: ${profile["annualElectricityKwh"]} kWh/year`);
    if (profile["annualGasKwh"]) items.push(`Gas: ${profile["annualGasKwh"]} kWh/year`);
    if (profile["hasEv"]) items.push("EV owner");
    if (profile["hasSolar"]) items.push("Solar panels");
    if (profile["carMake"] && profile["carModel"]) {
      items.push(`Vehicle: ${profile["carMake"]} ${profile["carModel"]} (${profile["carYear"] ?? "year unknown"})`);
    }
    if (profile["annualMileage"]) items.push(`Annual mileage: ${profile["annualMileage"]}`);
    if (profile["claimsLast5Years"] !== null && profile["claimsLast5Years"] !== undefined) {
      items.push(`Claims in last 5 years: ${profile["claimsLast5Years"]}`);
    }
    if (typeof profile["smoker"] === "boolean") items.push(profile["smoker"] ? "Smoker" : "Non-smoker");
  }

  // Confirmed current deal cost
  const confirmedCost = Object.entries(dealFields)
    .filter(([, pf]) => (pf.source === "user" || pf.source === "extracted_confirmed") && pf.value !== null)
    .map(([k, pf]) => `${k}: ${pf.value}`)
    .join(", ");
  if (confirmedCost) items.push(`Current deal: ${confirmedCost}`);

  // Requirements
  const reqSummary = Object.entries(reqFields)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  if (reqSummary) items.push(`Requirements: ${reqSummary}`);

  if (items.length === 0) items.push("No household profile or deal data provided — research based on service details only");

  return items;
}
