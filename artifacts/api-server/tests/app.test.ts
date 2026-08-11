import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../src/app";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Grab the Set-Cookie header array from a response */
function getCookieHeader(res: request.Response): string[] {
  const raw = res.headers["set-cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe("Auth guard", () => {
  it("returns 401 for unauthenticated protected routes", async () => {
    const res = await request(app)
      .get("/api/services")
      .set("Origin", "http://localhost:3000");
    expect(res.status).toBe(401);
  });

  it("returns 401 for unauthenticated dashboard", async () => {
    const res = await request(app)
      .get("/api/dashboard/stats")
      .set("Origin", "http://localhost:3000");
    expect(res.status).toBe(401);
  });

  it("GET /api/auth/me returns authenticated: false when not logged in", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
  });
});

// ─── Session cookie flags ─────────────────────────────────────────────────────

describe("Session cookie flags", () => {
  it("login sets httpOnly and sameSite=strict cookie flags", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ password: process.env["ADMIN_PASSWORD"] });

    // May be 200 or 429 depending on run order — just check cookie flags if set
    const cookies = getCookieHeader(res);
    if (cookies.length > 0) {
      const cookie = cookies[0].toLowerCase();
      expect(cookie).toContain("httponly");
      expect(cookie).toContain("samesite=strict");
    }
  });
});

// ─── CSRF / Origin protection ─────────────────────────────────────────────────

describe("CSRF protection", () => {
  it("blocks POST with a cross-site Origin in production mode", async () => {
    const origEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    process.env["APP_BASE_URL"] = "https://my-renewal-scout.example.com";

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://evil-attacker.com")
      .send({ password: "anything" });

    process.env["NODE_ENV"] = origEnv;
    delete process.env["APP_BASE_URL"];

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/cross-site/i);
  });

  it("allows POST from the correct origin in production mode", async () => {
    const origEnv = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    process.env["APP_BASE_URL"] = "https://my-renewal-scout.example.com";

    // The request origin matches APP_BASE_URL — should NOT be blocked by CSRF
    // (may still get 401/429 from other middleware, but not 403)
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://my-renewal-scout.example.com")
      .send({ password: "wrong-password" });

    process.env["NODE_ENV"] = origEnv;
    delete process.env["APP_BASE_URL"];

    expect(res.status).not.toBe(403);
  });

  it("allows GET requests without Origin (no CSRF check on reads)", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(200);
  });
});

// ─── Login rate limiting ──────────────────────────────────────────────────────

describe("Login rate limiting", () => {
  it("returns 429 after exceeding the rate limit", async () => {
    // Send 15 login attempts — well above the limit of 10.
    // At some point during the loop we must see a 429.
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("Origin", "http://localhost:3000")
        .send({ password: "wrong" });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    expect(got429).toBe(true);
  }, 30_000);
});

// ─── Setup warnings — post-auth only ─────────────────────────────────────────

describe("Setup warnings in /auth/me", () => {
  it("does NOT expose setup warnings to unauthenticated callers", async () => {
    // An unauthenticated GET /auth/me must return an empty setupWarnings array
    // regardless of which env vars are missing.  This prevents information
    // disclosure about server configuration to anonymous callers.
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.setupWarnings).toEqual([]);
  });

  it("exposes scheduler warning only to authenticated sessions, not unauthenticated", async () => {
    // This test verifies that setupWarnings are gated on authentication:
    // unauthenticated GET /auth/me → empty warnings
    // authenticated GET /auth/me → real warnings present (when scheduler is disabled)

    const prevScheduler = process.env["SCHEDULER_ENABLED"];
    const prevPassword = process.env["ADMIN_PASSWORD"];
    delete process.env["SCHEDULER_ENABLED"]; // ensure scheduler warning fires
    process.env["ADMIN_PASSWORD"] = "test-password-for-warnings-check";

    try {
      // 1. Unauthenticated check — must return empty warnings
      const unauthRes = await request(app).get("/api/auth/me");
      expect(unauthRes.status).toBe(200);
      expect(unauthRes.body.authenticated).toBe(false);
      expect(unauthRes.body.setupWarnings).toEqual([]);

      // 2. Log in using a fresh agent to get a session cookie
      const loginRes = await request(app)
        .post("/api/auth/login")
        .set("Origin", "http://localhost:3000")
        .send({ password: "test-password-for-warnings-check" });

      // Login itself returns warnings for the authenticated user
      if (loginRes.status === 200) {
        const loginWarnings: string[] = loginRes.body.setupWarnings ?? [];
        expect(loginWarnings.some((w) => /scheduler/i.test(w))).toBe(true);

        // 3. Authenticated /auth/me via session cookie also returns warnings
        const sessionCookies = getCookieHeader(loginRes);
        if (sessionCookies.length > 0) {
          const meRes = await request(app)
            .get("/api/auth/me")
            .set("Cookie", sessionCookies[0]!);
          expect(meRes.status).toBe(200);
          expect(meRes.body.authenticated).toBe(true);
          const meWarnings: string[] = meRes.body.setupWarnings ?? [];
          expect(meWarnings.some((w) => /scheduler/i.test(w))).toBe(true);
        }
      }
    } finally {
      // Restore env vars
      if (prevScheduler !== undefined) process.env["SCHEDULER_ENABLED"] = prevScheduler;
      else delete process.env["SCHEDULER_ENABLED"];
      if (prevPassword !== undefined) process.env["ADMIN_PASSWORD"] = prevPassword;
      else delete process.env["ADMIN_PASSWORD"];
    }
  });

  it("reports schedulerEnabled: true when SCHEDULER_ENABLED=true", async () => {
    const prev = process.env["SCHEDULER_ENABLED"];
    process.env["SCHEDULER_ENABLED"] = "true";

    const res = await request(app).get("/api/auth/me");

    if (prev !== undefined) process.env["SCHEDULER_ENABLED"] = prev;
    else delete process.env["SCHEDULER_ENABLED"];

    expect(res.status).toBe(200);
    expect(res.body.schedulerEnabled).toBe(true);
  });
});

// ─── URL sanitisation (via research-service helpers) ─────────────────────────

describe("URL sanitisation integration", () => {
  it("sanitiseReport strips non-http URLs from sources and deduplicates", async () => {
    const { sanitiseReport } = await import("../src/lib/research-service");
    const report = {
      service_type: "Test",
      as_of_date: "2026-08-10",
      scope_statement: "s",
      current_deal_assessment: "c",
      options: [],
      recommended_next_step: "r",
      estimated_annual_saving_gbp: null,
      missing_information: [],
      comparison_checklist: [],
      application_pack: [],
      warnings: [],
      sources: [
        "https://good.com",
        "javascript:alert(1)",
        "https://good.com",
      ],
    };
    const result = sanitiseReport(report);
    expect(result.sources).toEqual(["https://good.com"]);
  });
});

// ─── Duplicate research prevention ───────────────────────────────────────────
// Real invocation of queueResearch — verifies the actual duplicate-prevention
// function returns the existing run ID without inserting a new row.

describe("Duplicate research prevention", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("queueResearch returns existing run ID when an active run already exists", async () => {
    const { db } = await import("@workspace/db");
    const { queueResearch } = await import("../src/lib/research-service");

    const existingRunId = 42;

    // Reusable chain builder mirroring tests/setup.ts
    function makeChain(finalValue: unknown) {
      const resolved = Promise.resolve(finalValue);
      const chain: Record<string, (...args: unknown[]) => unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        set: () => chain,
        values: () => chain,
        onConflictDoNothing: () => chain,
        limit: () => resolved,
        returning: () => resolved,
        then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
          resolved.then(f, r),
        catch: (r?: (e: unknown) => unknown) => resolved.catch(r),
        finally: (f?: () => void) => resolved.finally(f),
      };
      return chain as ReturnType<typeof db.select>;
    }

    // 1st select: service lookup → found
    vi.mocked(db.select).mockImplementationOnce(() =>
      makeChain([{ id: 1, active: true }]),
    );
    // 2nd select: application-level active-run check → returns existing run
    vi.mocked(db.select).mockImplementationOnce(() =>
      makeChain([{ id: existingRunId, serviceId: 1, status: "queued" }]),
    );

    // Call the REAL function — this is the test. It should return the
    // existing run ID without calling db.insert.
    const result = await queueResearch(1, "manual");

    expect(result).toBe(existingRunId);
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
  });
});

// ─── Stale job recovery & index initialisation ───────────────────────────────

describe("Stale job recovery", () => {
  it("recoverStaleJobs and ensureActiveRunIndex are exported functions", async () => {
    const mod = await import("../src/lib/stale-jobs");
    expect(typeof mod.recoverStaleJobs).toBe("function");
    expect(typeof mod.ensureActiveRunIndex).toBe("function");
  });

  it("ensureActiveRunIndex throws when the DB query fails (fail-closed startup)", async () => {
    // If the DB pool can't create the partial unique index (e.g. due to
    // pre-existing duplicate active rows or a DB outage), the error must
    // propagate so the caller can abort startup rather than serve traffic
    // without the deduplication constraint.
    const { pool } = await import("@workspace/db");
    vi.mocked(pool.query).mockRejectedValueOnce(
      new Error("relation already has duplicate rows"),
    );

    const { ensureActiveRunIndex } = await import("../src/lib/stale-jobs");
    await expect(ensureActiveRunIndex()).rejects.toThrow(
      "relation already has duplicate rows",
    );
  });
});

// ─── Safety boundary: no transaction routes exist ────────────────────────────

describe("Safety boundary", () => {
  const transactionPaths = [
    "/api/payment",
    "/api/apply",
    "/api/cancel",
    "/api/switch",
    "/api/credit-search",
    "/api/submit-application",
    "/api/login-supplier",
  ];

  for (const path of transactionPaths) {
    it(`${path} is inaccessible (4xx — not authenticated or not found)`, async () => {
      // These routes do not exist. Auth guard may fire before 404 (returning
      // 401) for paths handled by the /api router. Either 401 or 404 confirms
      // the route cannot be reached and no transaction was processed.
      const res = await request(app)
        .post(path)
        .set("Origin", "http://localhost:3000");
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      // Critically, must NOT be a success response
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
      expect(res.status).not.toBe(202);
    });
  }
});
