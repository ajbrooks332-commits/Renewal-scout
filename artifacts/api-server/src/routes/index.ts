import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import servicesRouter from "./services";
import researchRouter from "./research";
import dashboardRouter from "./dashboard";
import householdProfileRouter from "./household-profile";
import serviceRequirementsRouter from "./service-requirements";
import currentDealsRouter from "./current-deals";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(servicesRouter);
router.use(researchRouter);
router.use(dashboardRouter);
router.use(householdProfileRouter);
router.use(serviceRequirementsRouter);
router.use(currentDealsRouter);

export default router;
