import { Router, type IRouter } from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { timingSafeEqual } from "crypto";
import { LoginBody } from "@workspace/api-zod";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── Rate limiter: max 10 login attempts per 15 minutes per IP ───────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error:
      "Too many login attempts. Please wait 15 minutes before trying again.",
  },
  // Use req.ip (trusted via trust proxy) as the key
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
});

/**
 * Strict SCHEDULER_ENABLED check: only the case-insensitive string "true"
 * enables the scheduler. "1", "yes", unset, or any other value returns false.
 */
function isSchedulerEnabled(): boolean {
  return (process.env["SCHEDULER_ENABLED"] ?? "").toLowerCase() === "true";
}

function getSetupWarnings(): string[] {
  const warnings: string[] = [];
  if (!process.env["ADMIN_PASSWORD"]) {
    warnings.push("ADMIN_PASSWORD has not been set in Replit Secrets.");
  }
  if (!process.env["OPENAI_API_KEY"]) {
    warnings.push("OPENAI_API_KEY has not been set; research cannot run.");
  }
  if (!isSchedulerEnabled()) {
    warnings.push(
      "Automatic daily research is disabled. Set SCHEDULER_ENABLED=true in Replit Secrets to enable it.",
    );
  }
  return warnings;
}

/**
 * Timing-safe password comparison. Compares two strings without leaking
 * length or content information via timing side-channels.
 */
function passwordsMatch(candidate: string, stored: string): boolean {
  // Pad shorter buffer so timingSafeEqual can compare equal lengths
  const bufA = Buffer.from(candidate);
  const bufB = Buffer.from(stored);
  const len = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.concat([bufA], len);
  const paddedB = Buffer.concat([bufB], len);
  // Always run comparison (no short-circuit on length mismatch)
  const match = timingSafeEqual(paddedA, paddedB);
  return match && bufA.length === bufB.length;
}

// GET /auth/me — returns auth status and (post-auth only) setup warnings
// Setup warnings are only returned to authenticated users to avoid leaking
// configuration details (missing secrets, disabled scheduler) to anonymous callers.
router.get("/auth/me", (req, res): void => {
  const isAuthenticated = req.session?.authenticated === true;
  res.json({
    authenticated: isAuthenticated,
    schedulerEnabled: isSchedulerEnabled(),
    // Only expose setup warnings after authentication — prevents information
    // disclosure to unauthenticated callers about which secrets are missing.
    setupWarnings: isAuthenticated ? getSetupWarnings() : [],
  });
});

// POST /auth/login — rate-limited, timing-safe password check, session regeneration
router.post("/auth/login", loginLimiter, (req, res): void => {
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

  if (!passwordsMatch(parsed.data.password, adminPassword)) {
    res.status(401).json({ error: "Incorrect password." });
    return;
  }

  // Regenerate session to prevent session-fixation attacks
  req.session.regenerate((err) => {
    if (err) {
      // Log the full error server-side for diagnostics.
      // Never log passwords, cookies, session IDs or secrets.
      logger.error({ err }, "Session regeneration failed during login");
      res.status(500).json({ error: "Session error during login." });
      return;
    }
    req.session.authenticated = true;
    res.json({
      authenticated: true,
      schedulerEnabled: isSchedulerEnabled(),
      setupWarnings: getSetupWarnings(),
    });
  });
});

// POST /auth/logout
router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ authenticated: false, schedulerEnabled: false, setupWarnings: [] });
  });
});

export default router;
