import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { csrfProtection } from "./lib/csrf";

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
const isProduction = process.env["NODE_ENV"] === "production";

function buildCorsOrigin() {
  if (!isProduction) {
    return true;
  }

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

// ─── Public source download (no auth, no CSRF) ───────────────────────────────
import { readFileSync, existsSync } from "fs";

app.get("/api/download-source", (_req, res) => {
  const filePath = "/home/runner/workspace/renewal-scout-export.txt";
  if (!existsSync(filePath)) {
    res.status(404).send("Source export not found.");
    return;
  }
  const content = readFileSync(filePath, "utf8");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="renewal-scout-source.txt"');
  res.send(content);
});

// API routes
app.use("/api", router);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Scheduler and worker are started in index.ts (after DB readiness),
// so we import stop functions lazily on SIGTERM.
process.on("SIGTERM", async () => {
  const [{ stopScheduler }, { stopWorker }] = await Promise.all([
    import("./lib/scheduler"),
    import("./lib/worker"),
  ]);
  stopScheduler();
  stopWorker();
  process.exit(0);
});

export default app;
