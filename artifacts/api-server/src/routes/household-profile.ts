import { Router, type IRouter } from "express";
import { db, householdProfileTable } from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();
router.use(requireAuth);

const POSTCODE_MAX = 10;
const TEXT_MAX = 500;
const SHORT_MAX = 80;

/**
 * Convert raw request body into a safe partial update object.
 *
 * TRUE PATCH SEMANTICS: only keys that are explicitly present in `body` are
 * included in the returned object. Omitted keys are NOT written, which means
 * an update of { postcode: "SW1A1AA" } will not clear any other saved fields.
 *
 * Accepted value conventions:
 *  - null / undefined  → stored as null  (explicit "I don't know")
 *  - any string        → trimmed, max-clamped; empty string → null
 *  - any number        → coerced; NaN → null
 *  - any boolean       → coerced via strict check (only actual booleans/0/1)
 *
 * Monetary inputs (carValueGbp) arrive as GBP and are stored as integer pence.
 */
function sanitiseProfile(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const s = (key: string, max = TEXT_MAX): void => {
    if (!(key in body)) return;
    const v = body[key];
    if (v === null || v === undefined) { result[key] = null; return; }
    result[key] = String(v).trim().slice(0, max) || null;
  };
  const n = (key: string): void => {
    if (!(key in body)) return;
    const v = body[key];
    if (v === null || v === undefined) { result[key] = null; return; }
    const num = Number(v);
    result[key] = isNaN(num) ? null : Math.round(num);
  };
  const b = (key: string): void => {
    if (!(key in body)) return;
    const v = body[key];
    if (v === null || v === undefined) { result[key] = null; return; }
    result[key] = Boolean(v);
  };
  /**
   * Accept a GBP decimal value (e.g. 20000.00) and store as integer pence.
   * The result key in the returned object is the Drizzle column name.
   */
  const money = (bodyKey: string, dbKey: string): void => {
    if (!(bodyKey in body)) return;
    const v = body[bodyKey];
    if (v === null || v === undefined) { result[dbKey] = null; return; }
    const num = Number(v);
    result[dbKey] = isNaN(num) ? null : Math.round(num * 100);
  };

  s("postcode", POSTCODE_MAX);
  s("propertyType");
  s("tenure");
  n("bedrooms");
  n("yearBuilt");
  n("numAdults");
  n("numChildren");
  s("heatingType");
  b("hasEv");
  s("evChargerType");
  b("hasSolar");
  s("solarExportTariff", SHORT_MAX);
  n("annualElectricityKwh");
  n("annualGasKwh");
  b("hasSkyTv");
  b("hasSkyMobile");
  b("hasVirginMedia");
  n("numCars");
  s("carMake", SHORT_MAX);
  s("carModel", SHORT_MAX);
  n("carYear");
  // carValue from API is in GBP; stored as pence in carValuePence
  money("carValue", "carValuePence");
  n("annualMileage");
  s("drivingExperience");
  n("claimsLast5Years");
  b("smoker");
  s("accessibilityNeeds");
  s("generalPreferences");

  return result;
}

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
    carValue: row.carValuePence !== null && row.carValuePence !== undefined
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
      postcode: null, propertyType: null, tenure: null, bedrooms: null,
      yearBuilt: null, numAdults: null, numChildren: null,
      heatingType: null, hasEv: null, evChargerType: null,
      hasSolar: null, solarExportTariff: null,
      annualElectricityKwh: null, annualGasKwh: null,
      hasSkyTv: null, hasSkyMobile: null, hasVirginMedia: null,
      numCars: null, carMake: null, carModel: null, carYear: null,
      carValue: null, annualMileage: null, drivingExperience: null,
      claimsLast5Years: null, smoker: null,
      accessibilityNeeds: null, generalPreferences: null,
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
// Only fields that are present in the request body are written. Omitting a
// field preserves whatever value was previously stored for it. To explicitly
// clear a field, send it as null.
//
// Uses INSERT … ON CONFLICT (id) DO UPDATE SET … to atomically upsert the
// singleton row (id=1). Never runs an unqualified UPDATE.
router.put("/household-profile", async (req, res): Promise<void> => {
  const body = req.body as Record<string, unknown>;
  const patch = sanitiseProfile(body);

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "Request body must contain at least one profile field." });
    return;
  }

  // Always target id=1 (the singleton row).
  const insertValues = { id: 1, ...patch };

  // Build the ON CONFLICT update — only update columns present in patch.
  const conflictUpdate: Record<string, unknown> = { ...patch, updatedAt: new Date() };

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
