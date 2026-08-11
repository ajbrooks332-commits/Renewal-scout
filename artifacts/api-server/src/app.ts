import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { sessionMiddleware } from "./lib/session";
import { csrfProtection } from "./lib/csrf";

const app: Express = express();

// ─── Proxy trust ─────────────────────────────────────────────────────────────
// Replit routes all traffic through exactly one reverse-proxy hop (their load
// balancer). Trusting 1 hop makes req.ip, req.protocol, and req.hostname
// reflect the real client values from X-Forwarded-* headers.
// Do NOT use `true` here (trusts every proxy unconditionally — unsafe on a
// public internet host).
app.set("trust proxy", 1);

// ─── Security headers ─────────────────────────────────────────────────────────
// Helmet disables x-powered-by, sets X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, and more by default.  We layer on an explicit CSP and
// restrict the referrer policy for the JSON API.
const isProduction = process.env["NODE_ENV"] === "production";

app.use(
  helmet({
    // Content-Security-Policy for the API server.
    // This is a JSON-only backend; no scripts, styles or frames are served.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Prevent browsers from sending the Referer header to third parties —
    // important because error pages may embed request paths.
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  }),
);

// ─── Structured request logging ───────────────────────────────────────────────
// Redacts auth/cookie headers from logs automatically via custom serialisers.
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
//
// Production: exact validated allowlist from APP_BASE_URL / CORS_ORIGIN env vars.
//   Unknown origins receive a CORS error (callback passes an Error to cors).
//
// Development: controlled list limited to localhost on any port and the
//   Replit dev domain (if available). `origin: true` is intentionally avoided
//   because it allows ANY origin — too broad even for development.

function buildCorsOrigin() {
  if (!isProduction) {
    // Development: allow localhost on any port and the Replit dev domain.
    const devAllowed = new Set<string>();

    const replitDev = process.env["REPLIT_DEV_DOMAIN"];
    if (replitDev) {
      // Replit exposes the dev app at https://<REPLIT_DEV_DOMAIN>
      devAllowed.add(`https://${replitDev}`);
    }

    return (
      origin: string | undefined,
      cb: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) {
        // No origin header (server-to-server, curl, Postman) — allow in dev
        cb(null, true);
        return;
      }
      // Allow localhost on any port or the Replit dev domain.
      // All other origins are denied — even in development — to avoid
      // behaving like the removed `origin: true` (which allowed everything).
      const isLocalhost =
        /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
        /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
      if (isLocalhost || devAllowed.has(origin)) {
        cb(null, true);
      } else {
        // Deny CORS (no Access-Control-Allow-Origin header → browser blocks
        // preflight), but do NOT pass an Error so the request still reaches
        // the CSRF middleware which provides the server-side 403.
        // Passing new Error() here would skip CSRF and return 500 via the
        // global error handler — the wrong response for cross-origin mutations.
        cb(null, false);
      }
    };
  }

  // Production: strict allowlist
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
      // ignore malformed URL — validated at startup in index.ts
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

// ─── Body parsers ─────────────────────────────────────────────────────────────
// Explicit size limits prevent memory exhaustion from large payloads.
// 1 MB is generous for a JSON API; multipart (document upload) is handled
// by multer in the individual route and has its own 10 MB limit.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(sessionMiddleware);

// ─── CSRF / Origin validation on all mutation routes ──────────────────────────
app.use("/api", csrfProtection);

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api", router);

// ─── Global error handler ─────────────────────────────────────────────────────
// Must be registered AFTER all routes and other middleware.
// Catches any error passed to next(err) or thrown from async route handlers
// that have been wrapped by a try/catch or express-async-errors.
//
// Security: never return stack traces, DB connection strings, SQL text, or
// OpenAI internals to clients.  Log the full error server-side only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { status?: number; statusCode?: number }).statusCode
    ?? 500;

  logger.error({ err }, "Unhandled request error");

  if (res.headersSent) return;

  // For client errors (4xx), return the error message — it is intentional and
  // safe.  For server errors (5xx), return a generic message only; never
  // expose stack traces, DB internals, or upstream API responses.
  const message =
    status < 500
      ? err.message
      : "An internal server error occurred. Please try again later.";

  res.status(status).json({ error: message });
});

export default app;
