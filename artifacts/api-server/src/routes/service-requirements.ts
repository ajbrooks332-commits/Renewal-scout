import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, servicesTable, serviceRequirementsTable } from "@workspace/db";
import { StrictUpdateServiceRequirementsBody, parseRouteId } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();
router.use(requireAuth);

/**
 * Known requirement field keys per service type.
 *
 * Fields not in this list are silently discarded on write (the top-level
 * body keys are strictly validated by the Zod schema; only field names
 * inside `fields` are filtered here).
 *
 * Answer-state semantics:
 *   Key absent from stored `fields`  → unanswered / never asked
 *   Key present with null value      → explicitly "I don't know"
 *   Key present with non-null value  → answered
 */
export const KNOWN_FIELDS: Record<string, string[]> = {
  // ── Broadband ─────────────────────────────────────────────────────────────
  // Core requirements
  Broadband: [
    "downloadSpeedMbps",
    "uploadSpeedMbps",
    "simultaneousUsers",
    "workFromHome",
    "videoCallsFrequent",
    "onlineGaming",
    "streamingHd",
    "landlineRequired",
    "fullFibrePreferred",
    "maxContractMonths",
    "maxMonthlyBudgetGbp",
    // Bundle links (links to existing subscriptions)
    "linkedSkyTv",
    "linkedSkyMobile",
    "linkedVirginMedia",
    "bundleDiscountImportant",
    "willingToSplitBundle",
    // Legacy / still supported
    "contractLengthMonths",
    "includesLineRental",
    "tvAddon",
    "homePhoneAddon",
  ],

  // ── Electricity ───────────────────────────────────────────────────────────
  Electricity: [
    // Tariff preferences
    "tariffType",        // fixed | variable | tracker | economy7 | any
    "tariffPreference",  // alias/extension
    "greenPreferred",
    "paymentMethod",     // direct_debit | prepay | quarterly
    // Usage data
    "annualKwh",
    "dayNightSplit",     // Economy 7 (boolean)
    "dayUsagePercent",   // % of usage in peak hours
    // Smart meter
    "smartMeter",
    "smartMeterType",    // SMETS1 | SMETS2 | none
    // EV-specific energy requirements
    "evMake",
    "evModel",
    "evBatteryCapacityKwh",
    "evAnnualMileage",
    "homeChargerKw",
    "overnightChargingStart", // e.g. "23:00"
    "overnightChargingEnd",
    "shiftToOffPeak",
    // Solar / home battery
    "solarPanels",
    "solarExportTariff",
    "homeBattery",
    "homeBatteryCapacityKwh",
  ],

  // ── Gas and electricity ───────────────────────────────────────────────────
  "Gas and electricity": [
    "tariffType",
    "tariffPreference",
    "greenPreferred",
    "paymentMethod",
    "annualElectricityKwh",
    "annualGasKwh",
    "dayNightSplit",
    "dayUsagePercent",
    "smartMeter",
    "smartMeterType",
    "evMake",
    "evModel",
    "evBatteryCapacityKwh",
    "evAnnualMileage",
    "homeChargerKw",
    "overnightChargingStart",
    "overnightChargingEnd",
    "shiftToOffPeak",
    "solarPanels",
    "solarExportTariff",
    "homeBattery",
    "homeBatteryCapacityKwh",
  ],

  // ── Car insurance ─────────────────────────────────────────────────────────
  "Car insurance": [
    "coverType",           // comprehensive | tpft | tpo
    "namedDrivers",
    "parkingLocation",     // garage | driveway | street
    "modifiedVehicle",
    "noClaimsYears",
    "useType",             // social | commuting | business
    "voluntaryExcessGbp",
  ],

  // ── Home insurance ────────────────────────────────────────────────────────
  "Home insurance": [
    "coverType",           // buildings_and_contents | buildings_only | contents_only
    "rebuildValueGbp",
    "contentsValueGbp",
    "voluntaryExcessGbp",
    "prevClaims",
    "highValueItems",
    "floodRisk",
  ],

  // ── Life insurance ────────────────────────────────────────────────────────
  "Life insurance": [
    "coverType",           // level_term | decreasing_term | whole_of_life
    "coverAmountGbp",
    "termYears",
    "jointPolicy",
    "criticalIllnessCover",
  ],

  // ── Credit card ───────────────────────────────────────────────────────────
  "Credit card": [
    "primaryUse",          // purchases | balance_transfer | travel | cashback
    "creditLimitGbp",
    "rewardPreference",
    "balanceTransfer",
  ],

  // ── Loan ──────────────────────────────────────────────────────────────────
  Loan: ["purposeOfLoan", "amountGbp", "termMonths"],

  // ── Mobile phone ─────────────────────────────────────────────────────────
  "Mobile phone": [
    "dataGb",
    "includesHandset",
    "networkPreference",
    "contractMonths",
    "roamingNeeded",
  ],
};

// GET /services/:id/requirements
router.get("/services/:id/requirements", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const [req_row] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, id));

  if (!req_row) {
    res.json({
      serviceId: id,
      schemaVersion: "1",
      fields: {},
      unknownFields: [],
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  res.json({
    serviceId:    req_row.serviceId,
    schemaVersion: req_row.schemaVersion,
    fields:        req_row.fields,
    unknownFields: req_row.unknownFields ?? [],
    updatedAt:     req_row.updatedAt.toISOString(),
  });
});

// PUT /services/:id/requirements
router.put("/services/:id/requirements", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  // Validate top-level structure: must have a `fields` object; unknown top-level
  // keys rejected by .strict() in the Zod schema.
  const parsed = StrictUpdateServiceRequirementsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  // Filter to known fields for this service type.
  // Unknown field names are silently discarded (extensible — only body keys
  // are strictly validated above). Key presence (even with null value) is
  // preserved because null = "I don't know" (not missing).
  const allowed = new Set(KNOWN_FIELDS[service.serviceType] ?? []);
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(parsed.data.fields)) {
    if (allowed.has(key)) {
      filtered[key] = parsed.data.fields[key]; // null = "I don't know"
    }
  }

  // unknownFields: array of field names the user explicitly marked as unknown.
  // Filter to only known fields to avoid storing junk.
  const unknownFields = (parsed.data.unknownFields ?? []).filter((k) =>
    allowed.has(k),
  );

  const [existing] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, id));

  let row;
  if (existing) {
    [row] = await db
      .update(serviceRequirementsTable)
      .set({ fields: filtered, unknownFields, updatedAt: new Date() })
      .where(eq(serviceRequirementsTable.serviceId, id))
      .returning();
  } else {
    [row] = await db
      .insert(serviceRequirementsTable)
      .values({ serviceId: id, fields: filtered, unknownFields })
      .returning();
  }

  res.json({
    serviceId:    row!.serviceId,
    schemaVersion: row!.schemaVersion,
    fields:        row!.fields,
    unknownFields: row!.unknownFields ?? [],
    updatedAt:     row!.updatedAt.toISOString(),
  });
});

export { KNOWN_FIELDS as default_export };
export default router;
