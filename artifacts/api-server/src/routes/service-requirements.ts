import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, servicesTable, serviceRequirementsTable } from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();
router.use(requireAuth);

function parseId(raw: string | undefined): number | null {
  const n = parseInt(raw ?? "", 10);
  return isNaN(n) ? null : n;
}

// Known requirement field keys per service type — used for validation
const KNOWN_FIELDS: Record<string, string[]> = {
  Broadband: [
    "downloadSpeedMbps", "uploadSpeedMbps", "contractLengthMonths",
    "includesLineRental", "tvAddon", "homePhoneAddon",
  ],
  Electricity: [
    "annualKwh", "tariffType", "greenPreferred", "smartMeter",
  ],
  "Gas and electricity": [
    "annualElectricityKwh", "annualGasKwh", "tariffType",
    "greenPreferred", "smartMeter",
  ],
  "Car insurance": [
    "coverType", "namedDrivers", "parkingLocation", "modifiedVehicle",
    "noClaimsYears", "useType", "voluntaryExcessGbp",
  ],
  "Home insurance": [
    "coverType", "rebuildValueGbp", "contentsValueGbp",
    "voluntaryExcessGbp", "prevClaims", "highValueItems",
    "floodRisk",
  ],
  "Life insurance": [
    "coverType", "coverAmountGbp", "termYears", "jointPolicy",
    "criticalIllnessCover",
  ],
  "Credit card": [
    "primaryUse", "creditLimitGbp", "rewardPreference",
    "balanceTransfer",
  ],
  Loan: [
    "purposeOfLoan", "amountGbp", "termMonths",
  ],
  "Mobile phone": [
    "dataGb", "includesHandset", "networkPreference", "contractMonths",
    "roamingNeeded",
  ],
};

// GET /services/:id/requirements
router.get("/services/:id/requirements", async (req, res): Promise<void> => {
  const id = parseId(req.params["id"]);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) { res.status(404).json({ error: "Service not found." }); return; }

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
  const id = parseId(req.params["id"]);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) { res.status(404).json({ error: "Service not found." }); return; }

  const body = req.body as { fields?: Record<string, unknown> };
  if (!body.fields || typeof body.fields !== "object") {
    res.status(400).json({ error: "fields object is required." });
    return;
  }

  // Filter to known fields for this service type (ignore unknown keys)
  const allowed = KNOWN_FIELDS[service.serviceType] ?? [];
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in body.fields) {
      filtered[key] = body.fields[key]; // null = "I don't know"
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
