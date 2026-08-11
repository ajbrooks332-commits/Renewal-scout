import { Router, type IRouter } from "express";
import { db, householdProfileTable } from "@workspace/db";
import { StrictUpdateHouseholdProfileBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth);

function profileToApi(row: typeof householdProfileTable.$inferSelect) {
  return {
    id: row.id,
    postcode: row.postcode ?? null,
    propertyType: row.propertyType ?? null,
    tenure: row.tenure ?? null,
    bedrooms: row.bedrooms ?? null,
    yearBuilt: row.yearBuilt ?? null,
    numAdults: row.numAdults ?? null,
    numChildren: row.numChildren ?? null,
    heatingType: row.heatingType ?? null,
    hasEv: row.hasEv ?? null,
    evChargerType: row.evChargerType ?? null,
    hasSolar: row.hasSolar ?? null,
    solarExportTariff: row.solarExportTariff ?? null,
    annualElectricityKwh: row.annualElectricityKwh ?? null,
    annualGasKwh: row.annualGasKwh ?? null,
    hasSkyTv: row.hasSkyTv ?? null,
    hasSkyMobile: row.hasSkyMobile ?? null,
    hasVirginMedia: row.hasVirginMedia ?? null,
    numCars: row.numCars ?? null,
    carMake: row.carMake ?? null,
    carModel: row.carModel ?? null,
    carYear: row.carYear ?? null,
    // carValuePence stored as integer pence; return as GBP decimal to API consumers
    carValue:
      row.carValuePence !== null && row.carValuePence !== undefined
        ? row.carValuePence / 100
        : null,
    annualMileage: row.annualMileage ?? null,
    drivingExperience: row.drivingExperience ?? null,
    claimsLast5Years: row.claimsLast5Years ?? null,
    smoker: row.smoker ?? null,
    accessibilityNeeds: row.accessibilityNeeds ?? null,
    generalPreferences: row.generalPreferences ?? null,
    questionnaireVersion: row.questionnaireVersion,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

// GET /household-profile — returns the singleton row (or an empty profile)
router.get("/household-profile", async (_req, res): Promise<void> => {
  const [row] = await db.select().from(householdProfileTable).limit(1);
  if (!row) {
    res.json({
      id: 0,
      postcode: null,
      propertyType: null,
      tenure: null,
      bedrooms: null,
      yearBuilt: null,
      numAdults: null,
      numChildren: null,
      heatingType: null,
      hasEv: null,
      evChargerType: null,
      hasSolar: null,
      solarExportTariff: null,
      annualElectricityKwh: null,
      annualGasKwh: null,
      hasSkyTv: null,
      hasSkyMobile: null,
      hasVirginMedia: null,
      numCars: null,
      carMake: null,
      carModel: null,
      carYear: null,
      carValue: null,
      annualMileage: null,
      drivingExperience: null,
      claimsLast5Years: null,
      smoker: null,
      accessibilityNeeds: null,
      generalPreferences: null,
      questionnaireVersion: "1",
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
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
//
// Only fields present in the request body are written (true PATCH semantics).
// Uses INSERT … ON CONFLICT (id) DO UPDATE SET … to atomically upsert the
// singleton row (id=1). Never runs an unqualified UPDATE.
router.put("/household-profile", async (req, res): Promise<void> => {
  const parsed = StrictUpdateHouseholdProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  // Build the patch from only the keys that were explicitly present in the body.
  // Zod returns `undefined` for optional fields not present; we exclude those
  // so absent keys are not written (true PATCH semantics).
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined) continue;

    // carValue (GBP decimal) → carValuePence (integer pence) for DB storage
    if (key === "carValue") {
      patch["carValuePence"] = value !== null ? Math.round((value as number) * 100) : null;
    } else {
      patch[key] = value;
    }
  }

  // Normalise postcode to uppercase with space before inward code
  if (typeof patch["postcode"] === "string" && patch["postcode"] !== "") {
    const raw = (patch["postcode"] as string).replace(/\s+/g, "").toUpperCase();
    patch["postcode"] = raw.slice(0, -3) + " " + raw.slice(-3);
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({
      error: "Request body must contain at least one profile field.",
    });
    return;
  }

  // Always target id=1 (the singleton row).
  const insertValues = { id: 1, ...patch };

  // Build the ON CONFLICT update — only update columns present in patch.
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
