import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { csrfProtection } from "./lib/csrf";
import { startScheduler, stopScheduler } from "./lib/scheduler";

const app: Express = express();

// Trust Replit's reverse proxy so req.ip and req.protocol are correct
app.set("trust proxy", 1);

// Security headers
app.use(helmet());

// Structured request logging (redacts auth/cookie headers)
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// ─── CORS ────────────────────────────────────────────────────────────────────
// In production restrict to an explicit allowlist; in development allow Vite
// dev origins and the Replit proxy domain (same-origin via proxy).
const isProduction = process.env["NODE_ENV"] === "production";

function buildCorsOrigin() {
  if (!isProduction) {
    // Development: allow all origins (Vite dev server, Postman, curl, etc.)
    return true;
  }

  // Production: build allowlist from env vars
  const allowed = new Set<string>();

  const corsOriginEnv = process.env["CORS_ORIGIN"];
  if (corsOriginEnv) {
    corsOriginEnv
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean)
      .forEach((o) => allowed.add(o));
  }

  const appBaseUrl = process.env["APP_BASE_URL"];
  if (appBaseUrl) {
    try {
      allowed.add(new URL(appBaseUrl).origin);
    } catch {
      // ignore malformed URL
    }
  }

  if (allowed.size === 0) {
    logger.warn(
      "No CORS_ORIGIN or APP_BASE_URL configured — cross-origin requests will be rejected in production",
    );
  }

  return (
    origin: string | undefined,
    cb: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (!origin || allowed.has(origin)) {
      cb(null, true);
    } else {
      cb(new Error(`CORS: origin ${origin} not allowed`));
    }
  };
}

app.use(cors({ credentials: true, origin: buildCorsOrigin() }));

// Body parsers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Session middleware (PostgreSQL-backed store)
app.use(sessionMiddleware);

// CSRF / Origin validation on all mutation routes
app.use("/api", csrfProtection);

// API routes
app.use("/api", router);

// Start daily scheduler on first import
startScheduler();

// Graceful shutdown
process.on("SIGTERM", () => {
  stopScheduler();
  process.exit(0);
});

export default app;
