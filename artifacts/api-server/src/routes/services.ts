import { Router, type IRouter } from "express";
import { eq, asc } from "drizzle-orm";
import { db, servicesTable } from "@workspace/db";
import { CreateServiceBody, UpdateServiceBody, GetServiceParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import {
  queueResearch,
  executeResearch,
  toApiReport,
  serviceToApi,
} from "../lib/research-service";
import { daysUntilTarget } from "../lib/renewal-logic";

const router: IRouter = Router();

router.use(requireAuth);

function parseId(raw: string | string[] | undefined): number | null {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const n = parseInt(s ?? "", 10);
  return isNaN(n) ? null : n;
}

function buildServiceValues(data: Record<string, unknown>) {
  return {
    serviceType: (data.serviceType as string | undefined) ?? "Other",
    provider: (data.provider as string) ?? "",
    productName: (data.productName as string | null | undefined) ?? null,
    monthlyCostGbp: (data.monthlyCostGbp as number | null | undefined) ?? null,
    annualCostGbp: (data.annualCostGbp as number | null | undefined) ?? null,
    renewalDate: (data.renewalDate as string | null | undefined) ?? null,
    contractEndDate:
      (data.contractEndDate as string | null | undefined) ?? null,
    noticeDays: (data.noticeDays as number | undefined) ?? 30,
    researchWindowDays: (data.researchWindowDays as number | undefined) ?? 60,
    location: (data.location as string | null | undefined) ?? null,
    currentTerms: (data.currentTerms as string | null | undefined) ?? null,
    preferences: (data.preferences as string | null | undefined) ?? null,
    quoteFacts: (data.quoteFacts as string | null | undefined) ?? null,
    autoResearch: (data.autoResearch as boolean | undefined) ?? true,
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
  const parsed = CreateServiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.provider?.trim()) {
    res.status(400).json({ error: "Provider is required." });
    return;
  }
  const values = buildServiceValues(parsed.data as Record<string, unknown>);
  const [service] = await db
    .insert(servicesTable)
    .values(values)
    .returning();
  res.status(201).json(serviceToApi(service));
});

// GET /services/:id
router.get("/services/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const { researchRunsTable } = await import("@workspace/db");
  const { desc } = await import("drizzle-orm");

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) { res.status(404).json({ error: "Service not found." }); return; }

  const runs = await db
    .select()
    .from(researchRunsTable)
    .where(eq(researchRunsTable.serviceId, id))
    .orderBy(desc(researchRunsTable.createdAt))
    .limit(12);

  const latestComplete = runs.find((r) => r.status === "complete") ?? null;
  const latestReport = latestComplete ? toApiReport(latestComplete.reportJson) : null;

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

  res.json({
    service: serviceToApi(service),
    runs: runsForApi,
    latestReport: latestReport ?? null,
  });
});

// PUT /services/:id
router.put("/services/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const parsed = UpdateServiceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!parsed.data.provider?.trim()) {
    res.status(400).json({ error: "Provider is required." });
    return;
  }
  const values = buildServiceValues(parsed.data as Record<string, unknown>);
  const [service] = await db
    .update(servicesTable)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(servicesTable.id, id))
    .returning();
  if (!service) { res.status(404).json({ error: "Service not found." }); return; }
  res.json(serviceToApi(service));
});

// POST /services/:id/archive
router.post("/services/:id/archive", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  const [service] = await db
    .update(servicesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(servicesTable.id, id))
    .returning();
  if (!service) { res.status(404).json({ error: "Service not found." }); return; }
  res.json(serviceToApi(service));
});

// POST /services/:id/research
router.post("/services/:id/research", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  if (!id) { res.status(400).json({ error: "Invalid id" }); return; }

  let runId: number;
  try {
    runId = await queueResearch(id, "manual");
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
    return;
  }

  // Fire research in background
  executeResearch(runId).catch((e) =>
    req.log.error({ e }, "Background research error")
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
