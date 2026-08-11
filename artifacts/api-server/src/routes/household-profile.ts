import { Router, type IRouter } from "express";
import { db, householdProfileTable } from "@workspace/db";
import type { VehicleRecord } from "@workspace/db";
import { StrictUpdateHouseholdProfileBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth);

// ─── API shape ────────────────────────────────────────────────────────────────

function profileToApi(row: typeof householdProfileTable.$inferSelect) {
  const vehicles = Array.isArray(row.vehicles)
    ? (row.vehicles as VehicleRecord[])
    : [];

  // Expose carValue as GBP decimal (stored as integer pence)
  const carValueGbp =
    row.carValuePence !== null && row.carValuePence !== undefined
      ? row.carValuePence / 100
      : null;

  return {
    id:                   row.id,
    postcode:             row.postcode ?? null,
    propertyType:         row.propertyType ?? null,
    tenure:               row.tenure ?? null,
    bedrooms:             row.bedrooms ?? null,
    yearBuilt:            row.yearBuilt ?? null,
    numAdults:            row.numAdults ?? null,
    numChildren:          row.numChildren ?? null,
    heatingType:          row.heatingType ?? null,
    hasEv:                row.hasEv ?? null,
    evChargerType:        row.evChargerType ?? null,
    hasSolar:             row.hasSolar ?? null,
    solarExportTariff:    row.solarExportTariff ?? null,
    annualElectricityKwh: row.annualElectricityKwh ?? null,
    annualGasKwh:         row.annualGasKwh ?? null,
    hasSkyTv:             row.hasSkyTv ?? null,
    hasSkyMobile:         row.hasSkyMobile ?? null,
    hasVirginMedia:       row.hasVirginMedia ?? null,
    numCars:              row.numCars ?? null,
    // Multi-vehicle: new vehicles array
    vehicles,
    // Legacy single-car fields (backward compat — populated from vehicles[0])
    carMake:              row.carMake ?? vehicles[0]?.make ?? null,
    carModel:             row.carModel ?? vehicles[0]?.model ?? null,
    carYear:              row.carYear ?? vehicles[0]?.year ?? null,
    carValue:             carValueGbp ?? (vehicles[0]?.valuePence != null ? vehicles[0].valuePence / 100 : null),
    annualMileage:        row.annualMileage ?? vehicles[0]?.annualMileage ?? null,
    drivingExperience:    row.drivingExperience ?? vehicles[0]?.drivingExperience ?? null,
    claimsLast5Years:     row.claimsLast5Years ?? vehicles[0]?.claimsLast5Years ?? null,
    smoker:               row.smoker ?? null,
    accessibilityNeeds:   row.accessibilityNeeds ?? null,
    generalPreferences:   row.generalPreferences ?? null,
    unknownFields:        Array.isArray(row.unknownFields) ? row.unknownFields : [],
    questionnaireVersion: row.questionnaireVersion,
    updatedAt:            row.updatedAt.toISOString(),
    createdAt:            row.createdAt.toISOString(),
  };
}

const EMPTY_PROFILE_RESPONSE = {
  id: 0,
  postcode: null, propertyType: null, tenure: null,
  bedrooms: null, yearBuilt: null,
  numAdults: null, numChildren: null,
  heatingType: null, hasEv: null, evChargerType: null,
  hasSolar: null, solarExportTariff: null,
  annualElectricityKwh: null, annualGasKwh: null,
  hasSkyTv: null, hasSkyMobile: null, hasVirginMedia: null,
  numCars: null,
  vehicles: [],
  carMake: null, carModel: null, carYear: null,
  carValue: null, annualMileage: null, drivingExperience: null,
  claimsLast5Years: null, smoker: null,
  accessibilityNeeds: null, generalPreferences: null,
  unknownFields: [],
  questionnaireVersion: "1",
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
};

// GET /household-profile — returns the singleton row (or an empty profile)
router.get("/household-profile", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(householdProfileTable).limit(1);
  if (!row) {
    res.json({ ...EMPTY_PROFILE_RESPONSE, updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() });
    return;
  }
  res.json(profileToApi(row));
});

// PUT /household-profile — partial upsert (PATCH semantics, singleton id=1)
//
// Validates against StrictUpdateHouseholdProfileBody:
//   - Unknown keys → 400 (not silently discarded)
//   - Booleans must be actual booleans (string "false" → 400)
//   - Integer fields must be integers (decimals → 400)
//   - UK postcodes validated and normalised
//   - unknownFields: array of field names where user said "I don't know"
//   - vehicles: array of VehicleRecord objects (multi-vehicle support)
//
// Only fields present in the request body are written (true PATCH semantics).
// Uses INSERT … ON CONFLICT (id) DO UPDATE SET … to atomically upsert.
router.put("/household-profile", async (req, res): Promise<void> => {
  const parsed = StrictUpdateHouseholdProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  // Build the patch from only the keys explicitly present in the body.
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;

    if (key === "carValue") {
      // GBP decimal → integer pence for DB storage
      patch["carValuePence"] =
        value !== null ? Math.round((value as number) * 100) : null;
    } else {
      patch[key] = value;
    }
  }

  // Normalise postcode to uppercase with space before inward code (e.g. "SW1A 1AA")
  if (typeof patch["postcode"] === "string" && patch["postcode"] !== "") {
    const raw = (patch["postcode"] as string).replace(/\s+/g, "").toUpperCase();
    patch["postcode"] = raw.slice(0, -3) + " " + raw.slice(-3);
  }

  // If vehicles array is provided, sync legacy single-car columns from vehicles[0].
  // ALL legacy car columns are written (including explicit nulls) to avoid stale
  // data persisting when a vehicle is removed or a field is cleared.
  // When vehicles is empty, all legacy car columns are nulled.
  if (Array.isArray(patch["vehicles"])) {
    const vehicles = patch["vehicles"] as VehicleRecord[];
    const first = vehicles[0] ?? null;

    // Only touch legacy columns that the caller did not explicitly supply.
    // This allows manual overrides while keeping the default sync behaviour.
    if (patch["carMake"] === undefined)        patch["carMake"]        = first?.make ?? null;
    if (patch["carModel"] === undefined)       patch["carModel"]       = first?.model ?? null;
    if (patch["carYear"] === undefined)        patch["carYear"]        = first?.year ?? null;
    if (patch["carValuePence"] === undefined)  patch["carValuePence"]  = first?.valuePence ?? null;
    if (patch["annualMileage"] === undefined)  patch["annualMileage"]  = first?.annualMileage ?? null;
    if (patch["drivingExperience"] === undefined) patch["drivingExperience"] = first?.drivingExperience ?? null;
    if (patch["claimsLast5Years"] === undefined)  patch["claimsLast5Years"]  = first?.claimsLast5Years ?? null;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      error: "Request body must contain at least one profile field.",
    });
    return;
  }

  const insertValues = { id: 1, ...patch };
  const conflictUpdate: Record<string, unknown> = {
    ...patch,
    updatedAt: new Date(),
  };

  const [upserted] = await db
    .insert(householdProfileTable)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values(insertValues as any)
    .onConflictDoUpdate({
      target: householdProfileTable.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: conflictUpdate as any,
    })
    .returning();

  if (!upserted) {
    res.status(500).json({ error: "Failed to upsert household profile." });
    return;
  }

  logger.info({ keys: Object.keys(patch) }, "Household profile upserted (id=1)");
  res.json(profileToApi(upserted));
});

export default router;
