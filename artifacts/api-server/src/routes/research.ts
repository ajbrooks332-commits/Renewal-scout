import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, researchRunsTable, servicesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import { scanDueServices } from "../lib/research-service";

const router: IRouter = Router();

router.use(requireAuth);

// GET /research-runs — recent runs across all services
router.get("/research-runs", async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(researchRunsTable)
    .orderBy(desc(researchRunsTable.createdAt))
    .limit(20);

  // Fetch service info for each run
  const serviceIds = [...new Set(runs.map((r) => r.serviceId))];
  const services =
    serviceIds.length > 0
      ? await Promise.all(
          serviceIds.map((id) =>
            db
              .select({
                id: servicesTable.id,
                provider: servicesTable.provider,
                serviceType: servicesTable.serviceType,
              })
              .from(servicesTable)
              .where(eq(servicesTable.id, id))
              .limit(1)
              .then((rows) => rows[0] ?? null)
          )
        )
      : [];

  const serviceMap = new Map(services.filter(Boolean).map((s) => [s!.id, s!]));

  res.json(
    runs.map((r) => {
      const svc = serviceMap.get(r.serviceId);
      return {
        id: r.id,
        serviceId: r.serviceId,
        serviceName: svc?.provider ?? `Service #${r.serviceId}`,
        serviceType: svc?.serviceType ?? "Unknown",
        trigger: r.trigger,
        status: r.status,
        error: r.error ?? null,
        createdAt: r.createdAt.toISOString(),
        startedAt: r.startedAt?.toISOString() ?? null,
        completedAt: r.completedAt?.toISOString() ?? null,
      };
    })
  );
});

// POST /due-check
router.post("/due-check", async (_req, res): Promise<void> => {
  const runIds = await scanDueServices();
  res.status(202).json({
    queued: runIds.length,
    message:
      runIds.length === 0
        ? "No services are due for research right now."
        : `Queued research for ${runIds.length} service(s).`,
  });
});

export default router;
