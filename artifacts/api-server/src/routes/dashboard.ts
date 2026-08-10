import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, servicesTable } from "@workspace/db";
import { requireAuth } from "../middlewares/require-auth";
import {
  daysUntilTarget,
  needsResearch,
  effectiveAnnualCost,
} from "../lib/renewal-logic";

const router: IRouter = Router();

router.use(requireAuth);

router.get("/dashboard/stats", async (_req, res): Promise<void> => {
  const services = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.active, true));

  const totalAnnualCostGbp = services.reduce<number | null>((acc, s) => {
    const cost = effectiveAnnualCost(s);
    if (cost === null) return acc;
    return (acc ?? 0) + cost;
  }, null);

  const withinNinetyDays = services.filter((s) => {
    const days = daysUntilTarget(s);
    return days !== null && days >= 0 && days <= 90;
  }).length;

  const dueNow = services.filter((s) => needsResearch(s)).length;

  res.json({
    totalServices: services.length,
    totalAnnualCostGbp,
    withinNinetyDays,
    dueNow,
  });
});

export default router;
