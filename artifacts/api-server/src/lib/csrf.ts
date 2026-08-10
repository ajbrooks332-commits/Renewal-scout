import type { Request, Response, NextFunction } from "express";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getServerOrigin(req: Request): string {
  const appBaseUrl = process.env["APP_BASE_URL"];
  if (appBaseUrl) {
    try {
      return new URL(appBaseUrl).origin;
    } catch {
      // fall through
    }
  }
  const proto = req.protocol;
  const host = req.headers["host"] ?? "localhost";
  return `${proto}://${host}`;
}

function extractOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLocalhostOrigin(origin: string): boolean {
  return (
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
  );
}

/** Middleware: reject cross-site mutation requests based on Origin/Referer. */
export function csrfProtection(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATION_METHODS.has(req.method)) {
    next();
    return;
  }

  const rawOrigin = req.headers["origin"] as string | undefined;
  const rawReferer = req.headers["referer"] as string | undefined;
  const source = rawOrigin ?? rawReferer;

  if (!source) {
    // No origin/referer header present.
    // In production reject to be safe; in development allow (curl, Postman, etc.).
    if (process.env["NODE_ENV"] === "production") {
      res.status(403).json({ error: "CSRF: missing Origin header." });
      return;
    }
    next();
    return;
  }

  const requestOrigin = extractOrigin(source);
  if (!requestOrigin) {
    res.status(403).json({ error: "CSRF: invalid Origin header." });
    return;
  }

  // Allow same origin
  const serverOrigin = getServerOrigin(req);
  if (requestOrigin === serverOrigin) {
    next();
    return;
  }

  // Allow explicit CORS allowlist
  const corsOrigin = process.env["CORS_ORIGIN"];
  if (corsOrigin) {
    const allowed = corsOrigin
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    if (allowed.includes(requestOrigin)) {
      next();
      return;
    }
  }

  // In development allow localhost on any port
  if (
    process.env["NODE_ENV"] !== "production" &&
    isLocalhostOrigin(requestOrigin)
  ) {
    next();
    return;
  }

  res.status(403).json({ error: "CSRF: cross-site request blocked." });
}
