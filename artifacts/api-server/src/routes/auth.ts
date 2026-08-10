import { Router, type IRouter } from "express";
import { LoginBody } from "@workspace/api-zod";

const router: IRouter = Router();

function getSetupWarnings(): string[] {
  const warnings: string[] = [];
  if (!process.env["ADMIN_PASSWORD"]) {
    warnings.push("ADMIN_PASSWORD has not been set in Replit Secrets.");
  }
  if (!process.env["OPENAI_API_KEY"]) {
    warnings.push("OPENAI_API_KEY has not been set; research cannot run.");
  }
  return warnings;
}

router.get("/auth/me", (req, res): void => {
  res.json({
    authenticated: req.session?.authenticated === true,
    setupWarnings: getSetupWarnings(),
  });
});

router.post("/auth/login", (req, res): void => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing password." });
    return;
  }

  const adminPassword = process.env["ADMIN_PASSWORD"] ?? "";
  if (!adminPassword) {
    res.status(401).json({
      error:
        "ADMIN_PASSWORD has not been configured. Add it to Replit Secrets.",
    });
    return;
  }

  if (parsed.data.password !== adminPassword) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  req.session.authenticated = true;
  res.json({
    authenticated: true,
    setupWarnings: getSetupWarnings(),
  });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ authenticated: false, setupWarnings: [] });
  });
});

export default router;
