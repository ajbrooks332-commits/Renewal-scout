import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, servicesTable, serviceRequirementsTable } from "@workspace/db";
import { StrictUpdateServiceRequirementsBody, parseRouteId } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();
router.use(requireAuth);

// Known requirement field keys per service type — used to filter unknown field names
const KNOWN_FIELDS: Record<string, string[]> = {
  Broadband: [
    "downloadSpeedMbps",
    "uploadSpeedMbps",
    "contractLengthMonths",
    "includesLineRental",
    "tvAddon",
    "homePhoneAddon",
  ],
  Electricity: ["annualKwh", "tariffType", "greenPreferred", "smartMeter"],
  "Gas and electricity": [
    "annualElectricityKwh",
    "annualGasKwh",
    "tariffType",
    "greenPreferred",
    "smartMeter",
  ],
  "Car insurance": [
    "coverType",
    "namedDrivers",
    "parkingLocation",
    "modifiedVehicle",
    "noClaimsYears",
    "useType",
    "voluntaryExcessGbp",
  ],
  "Home insurance": [
    "coverType",
    "rebuildValueGbp",
    "contentsValueGbp",
    "voluntaryExcessGbp",
    "prevClaims",
    "highValueItems",
    "floodRisk",
  ],
  "Life insurance": [
    "coverType",
    "coverAmountGbp",
    "termYears",
    "jointPolicy",
    "criticalIllnessCover",
  ],
  "Credit card": [
    "primaryUse",
    "creditLimitGbp",
    "rewardPreference",
    "balanceTransfer",
  ],
  Loan: ["purposeOfLoan", "amountGbp", "termMonths"],
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
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  res.json({
    serviceId: req_row.serviceId,
    schemaVersion: req_row.schemaVersion,
    fields: req_row.fields,
    updatedAt: req_row.updatedAt.toISOString(),
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
  // keys are rejected.
  const parsed = StrictUpdateServiceRequirementsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  // Filter to known fields for this service type — unknown field names are
  // silently discarded (field names are extensible; only top-level body keys
  // are strictly validated above).
  const allowed = KNOWN_FIELDS[service.serviceType] ?? [];
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in parsed.data.fields) {
      filtered[key] = parsed.data.fields[key]; // null = "I don't know"
    }
  }

  const [existing] = await db
    .select()
    .from(serviceRequirementsTable)
    .where(eq(serviceRequirementsTable.serviceId, id));

  let row;
  if (existing) {
    [row] = await db
      .update(serviceRequirementsTable)
      .set({ fields: filtered, updatedAt: new Date() })
      .where(eq(serviceRequirementsTable.serviceId, id))
      .returning();
  } else {
    [row] = await db
      .insert(serviceRequirementsTable)
      .values({ serviceId: id, fields: filtered })
      .returning();
  }

  res.json({
    serviceId: row!.serviceId,
    schemaVersion: row!.schemaVersion,
    fields: row!.fields,
    updatedAt: row!.updatedAt.toISOString(),
  });
});

export { KNOWN_FIELDS };
export default router;
