import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { z } from "zod";
import { db, servicesTable } from "@workspace/db";
import {
  StrictCreateServiceBody,
  StrictUpdateServiceBody,
  parseRouteId,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import {
  queueResearch,
  executeResearch,
  toApiReport,
  serviceToApi,
} from "../lib/research-service";
import { daysUntilTarget } from "../lib/renewal-logic";
import { checkCompleteness } from "../lib/completeness";

const router: IRouter = Router();

router.use(requireAuth);

/**
 * Convert a GBP decimal value to integer pence for storage.
 * Returns null if the input is null/undefined.
 * Input must already be validated as a finite non-negative number.
 */
function gbpToPence(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(v * 100);
}

/**
 * Convert validated (Zod-parsed) service input into DB column values.
 * Trims whitespace from text fields.
 */
function buildServiceValues(
  data: z.infer<typeof StrictCreateServiceBody>,
) {
  return {
    serviceType: data.serviceType,
    provider: data.provider.trim(),
    productName: data.productName?.trim() ?? null,
    // API accepts GBP decimal; stored as integer pence
    monthlyCostPence: gbpToPence(data.monthlyCostGbp),
    annualCostPence: gbpToPence(data.annualCostGbp),
    renewalDate: data.renewalDate ?? null,
    contractEndDate: data.contractEndDate ?? null,
    noticeDays: data.noticeDays ?? 30,
    researchWindowDays: data.researchWindowDays ?? 60,
    location: data.location?.trim() ?? null,
    currentTerms: data.currentTerms ?? null,
    preferences: data.preferences ?? null,
    quoteFacts: data.quoteFacts ?? null,
    autoResearch: data.autoResearch ?? true,
  };
}

// GET /services
router.get("/services", async (_req, res): Promise<void> => {
  const services = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.active, true))
    .orderBy(asc(servicesTable.renewalDate));

  const sorted = services.sort((a, b) => {
    const da = daysUntilTarget(a);
    const db2 = daysUntilTarget(b);
    if (da === null && db2 === null) return 0;
    if (da === null) return 1;
    if (db2 === null) return -1;
    return da - db2;
  });

  res.json(sorted.map(serviceToApi));
});

// POST /services
router.post("/services", async (req, res): Promise<void> => {
  const parsed = StrictCreateServiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  const values = buildServiceValues(parsed.data);
  const [service] = await db.insert(servicesTable).values(values).returning();
  res.status(201).json(serviceToApi(service));
});

// GET /services/:id
router.get("/services/:id", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const { researchRunsTable } = await import("@workspace/db");
  const { desc } = await import("drizzle-orm");

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const runs = await db
    .select()
    .from(researchRunsTable)
    .where(eq(researchRunsTable.serviceId, id))
    .orderBy(desc(researchRunsTable.createdAt))
    .limit(12);

  const latestComplete = runs.find((r) => r.status === "complete") ?? null;
  const latestReport = latestComplete
    ? toApiReport(latestComplete.reportJson)
    : null;

  const runsForApi = runs.map((r) => ({
    id: r.id,
    serviceId: r.serviceId,
    trigger: r.trigger,
    status: r.status,
    error: r.error ?? null,
    report: r.status === "complete" ? toApiReport(r.reportJson) : null,
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
  }));

  const completenessReport = await checkCompleteness(id);

  res.json({
    service: serviceToApi(service),
    runs: runsForApi,
    latestReport: latestReport ?? null,
    completenessReport,
  });
});

// PUT /services/:id
router.put("/services/:id", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const parsed = StrictUpdateServiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Validation failed.",
      details: parsed.error.format(),
    });
    return;
  }

  const values = buildServiceValues(parsed.data);
  const [service] = await db
    .update(servicesTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(servicesTable.id, id))
    .returning();
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }
  res.json(serviceToApi(service));
});

// POST /services/:id/archive
router.post("/services/:id/archive", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .update(servicesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(servicesTable.id, id))
    .returning();
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }
  res.json(serviceToApi(service));
});

// POST /services/:id/research
router.post("/services/:id/research", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  // Completeness gate — 422 if blocking fields missing and forceWithMissing not set
  const body = (req.body ?? {}) as { forceWithMissing?: boolean };
  if (!body.forceWithMissing) {
    const completeness = await checkCompleteness(id);
    if (completeness.blocking) {
      res.status(422).json({
        error:
          "Missing required fields. Provide the missing information or pass forceWithMissing: true to proceed anyway.",
        missing: completeness.required,
        completenessReport: completeness,
      });
      return;
    }
  }

  let runId: number;
  try {
    runId = await queueResearch(id, "manual");
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
    return;
  }

  // Fire research in background
  executeResearch(runId).catch((e) =>
    req.log.error({ e }, "Background research error"),
  );

  const { researchRunsTable } = await import("@workspace/db");
  const [run] = await db
    .select()
    .from(researchRunsTable)
    .where(eq(researchRunsTable.id, runId));

  res.status(202).json({
    id: run.id,
    serviceId: run.serviceId,
    trigger: run.trigger,
    status: run.status,
    error: run.error ?? null,
    report: null,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  });
});

export default router;
