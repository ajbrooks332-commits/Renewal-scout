/**
 * Tests for Task #5 — Household profile, service requirements, current deals,
 * document extraction, and completeness gate.
 *
 * The DB mock is provided globally by tests/setup.ts (vi.mock("@workspace/db")).
 * Tests override specific calls with mockReturnValueOnce(makeChain(...)) so
 * every chain level is awaitable (routes may await at .where(), .from(), etc.).
 *
 * Key constraints:
 *  - Single beforeAll login avoids the 10-per-15-min rate limiter.
 *  - beforeEach(vi.clearAllMocks) flushes the mockReturnValueOnce queue so
 *    unconsumed values from one test don't corrupt the next.
 *    vi.clearAllMocks does NOT reset the vi.fn() default implementations
 *    set in setup.ts (select → makeChain([]), etc.).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";

vi.mock("openai");
vi.mock("file-type");
vi.mock("nodemailer");

// ─── Shared session ───────────────────────────────────────────────────────────
// Log in once per file to avoid hitting the rate limiter (max 10 per 15 min).

let authCookie = "";

beforeAll(async () => {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ password: process.env["ADMIN_PASSWORD"] });
  const raw = res.headers["set-cookie"] as string | string[] | undefined;
  authCookie = Array.isArray(raw) ? raw[0]! : (raw ?? "");
});

// Flush mockReturnValueOnce queues between tests to prevent bleed-through.
// vi.clearAllMocks() does NOT clear the queue; vi.resetAllMocks() does but
// also wipes default implementations, so we re-apply them afterwards.
beforeEach(async () => {
  vi.resetAllMocks();
  const { db } = await import("@workspace/db");
  vi.mocked(db.select).mockImplementation(() => makeChain([]));
  vi.mocked(db.insert).mockImplementation(() => makeChain([]));
  vi.mocked(db.update).mockImplementation(() => makeChain([]));
});

// ─── Mock chain builder ───────────────────────────────────────────────────────
// Routes often await `.where()` directly (no terminal `.limit()`), so every
// node in the chain must be a thenable.  This mirrors the makeChain in
// setup.ts but is local so tests can import it without circular issues.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain<T>(resolveWith: T): any {
  const resolved = Promise.resolve(resolveWith);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    set: () => chain,
    values: () => chain,
    onConflictDoNothing: () => chain,
    onConflictDoUpdate: () => chain,
    limit: () => resolved,
    returning: () => resolved,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (f?: (v: T) => any, r?: (e: unknown) => any) => resolved.then(f, r),
    catch: (r?: (e: unknown) => unknown) => resolved.catch(r),
    finally: (f?: () => void) => resolved.finally(f),
  };
  return chain;
}

// ─── Household profile ────────────────────────────────────────────────────────

describe("GET /api/household-profile", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/household-profile");
    expect(res.status).toBe(401);
  });

  it("returns a profile shape when none exists yet", async () => {
    // Default mock returns [] — simulates no profile row
    const res = await request(app)
      .get("/api/household-profile")
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("questionnaireVersion");
  });
});

// ─── Service requirements ─────────────────────────────────────────────────────

describe("PUT /api/services/:id/requirements", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .put("/api/services/1/requirements")
      .send({ fields: {} });
    expect(res.status).toBe(401);
  });

  it("returns 404 when service does not exist", async () => {
    // Default makeChain([]) → service not found
    const res = await request(app)
      .put("/api/services/9999/requirements")
      .set("Cookie", authCookie)
      .send({ fields: { downloadSpeedMbps: 100 } });
    expect(res.status).toBe(404);
  });

  it("returns 400 when fields property is missing", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );

    const res = await request(app)
      .put("/api/services/1/requirements")
      .set("Cookie", authCookie)
      .send({ notFields: "oops" });
    expect(res.status).toBe(400);
  });
});

// ─── Current deals ────────────────────────────────────────────────────────────

describe("GET /api/services/:id/current-deal", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/services/1/current-deal");
    expect(res.status).toBe(401);
  });

  it("returns serviceId and empty fields when no deal saved yet", async () => {
    const { db } = await import("@workspace/db");
    // Route calls: (1) service lookup, (2) getOrCreateDeal
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1, serviceType: "Broadband", provider: "BT" }]))
      .mockReturnValueOnce(makeChain([])); // no deal

    const res = await request(app)
      .get("/api/services/1/current-deal")
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(res.body.serviceId).toBe(1);
    expect(res.body.fields).toEqual({});
  });
});

describe("PUT /api/services/:id/current-deal", () => {
  it("rejects invalid provenance source", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );

    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({ fields: { provider: { value: "BT", source: "hacked" } } });
    expect(res.status).toBe(400);
  });

  it("accepts all four valid provenance sources", async () => {
    const { db } = await import("@workspace/db");
    // Route calls: (1) service, (2) getOrCreateDeal → returns [], (3) insert
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1, serviceType: "Broadband" }]))
      .mockReturnValueOnce(makeChain([])); // no existing deal
    vi.mocked(db.insert).mockReturnValueOnce(
      makeChain([{
        serviceId: 1,
        fields: { provider: { value: "BT", source: "user" } },
        lastConfirmedAt: null,
        updatedAt: new Date(),
      }])
    );

    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({ fields: { provider: { value: "BT", source: "user" } } });
    expect(res.status).toBe(200);
    expect(res.body.serviceId).toBe(1);
  });
});

// ─── Document extraction — MIME and size validation ───────────────────────────

describe("POST /api/services/:id/extract-document", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/services/1/extract-document")
      .attach("document", Buffer.from("fake"), "doc.pdf");
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file is uploaded", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );

    const res = await request(app)
      .post("/api/services/1/extract-document")
      .set("Cookie", authCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No document/i);
  });

  it("returns 415 for unsupported MIME type (GIF)", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );
    const { fileTypeFromBuffer } = await import("file-type");
    vi.mocked(fileTypeFromBuffer).mockResolvedValueOnce(
      { mime: "image/gif", ext: "gif" } as Awaited<
        ReturnType<typeof fileTypeFromBuffer>
      >
    );

    const res = await request(app)
      .post("/api/services/1/extract-document")
      .set("Cookie", authCookie)
      .attach("document", Buffer.from("fake-gif-content"), {
        filename: "image.gif",
        contentType: "image/gif",
      });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Unsupported/i);
  });

  it("returns 413 for files over 10 MB", async () => {
    const bigBuffer = Buffer.alloc(11 * 1024 * 1024, "x");
    const res = await request(app)
      .post("/api/services/1/extract-document")
      .set("Cookie", authCookie)
      .attach("document", bigBuffer, {
        filename: "big.pdf",
        contentType: "application/pdf",
      });
    expect(res.status).toBe(413);
  });
});

// ─── Completeness gate ────────────────────────────────────────────────────────

describe("completeness gate — POST /api/services/:id/research", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/services/1/research").send({});
    expect(res.status).toBe(401);
  });

  it("returns 422 for car insurance with no household data (blocking)", async () => {
    const { db } = await import("@workspace/db");
    const mockService = {
      id: 1, serviceType: "Car insurance", provider: "Admiral", active: true,
      autoResearch: true, renewalDate: null, contractEndDate: null,
      noticeDays: 30, researchWindowDays: 60,
    };

    // research route: (1) service
    // checkCompleteness: (2) service, (3) profile, (4) requirements, (5) deal
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService])) // research route service
      .mockReturnValueOnce(makeChain([mockService])) // checkCompleteness service
      .mockReturnValueOnce(makeChain([]))            // profile (empty)
      .mockReturnValueOnce(makeChain([]))            // requirements
      .mockReturnValueOnce(makeChain([]));           // deal

    const res = await request(app)
      .post("/api/services/1/research")
      .set("Cookie", authCookie)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty("completenessReport");
    expect(res.body.completenessReport.blocking).toBe(true);
    expect(res.body.completenessReport.required.length).toBeGreaterThan(0);
  });

  it("bypasses the completeness gate when forceWithMissing is true", async () => {
    const { db } = await import("@workspace/db");
    const mockService = {
      id: 1, serviceType: "Car insurance", provider: "Admiral", active: true,
      autoResearch: true, renewalDate: null, contractEndDate: null,
      noticeDays: 30, researchWindowDays: 60,
    };
    const mockRun = {
      id: 99, serviceId: 1, trigger: "manual", status: "queued",
      error: null, reportJson: null, createdAt: new Date(),
      startedAt: null, completedAt: null,
    };

    // research route: (1) service
    // checkCompleteness: (2) service, (3) profile, (4) requirements, (5) deal
    // insert run: via db.insert
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService])) // research route service
      .mockReturnValueOnce(makeChain([mockService])) // checkCompleteness service
      .mockReturnValueOnce(makeChain([]))            // profile (empty)
      .mockReturnValueOnce(makeChain([]))            // requirements
      .mockReturnValueOnce(makeChain([]));           // deal
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([mockRun]));

    const res = await request(app)
      .post("/api/services/1/research")
      .set("Cookie", authCookie)
      .send({ forceWithMissing: true });

    expect(res.status).not.toBe(422);
  });
});

// ─── Extraction confirmation — key integrity and merge semantics ───────────────

describe("extraction confirmation — merge semantics and key validation", () => {
  const mockService = { id: 1, serviceType: "Broadband", provider: "BT" };
  const mockExtraction = {
    id: 10,
    serviceId: 1,
    extractionId: "test-uuid-abc",
    fieldCount: 2,
    confirmedCount: 0,
    draftFieldKeys: ["monthlyCostGbp", "tariffName"],
    extractedAt: new Date(),
    deletedAt: null,
  };

  it("rejects confirmedFields keys not in the extraction draft", async () => {
    const { db } = await import("@workspace/db");
    // route: (1) service, (2) extraction
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]));

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // "provider" is NOT a draft key — only monthlyCostGbp and tariffName are
        confirmedFields: { provider: { value: "Injected", source: "extracted_confirmed" } },
        deletedFields: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/);
    expect(res.body.error).toMatch(/not in this extraction draft/i);
  });

  it("rejects deletedFields keys not in the extraction draft", async () => {
    const { db } = await import("@workspace/db");
    // route: (1) service, (2) extraction
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]));

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        confirmedFields: {},
        deletedFields: ["provider"], // not in this draft
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/);
    expect(res.body.error).toMatch(/not in this extraction draft/i);
  });

  it("deleting a draft field preserves a pre-existing user-entered value for that key", async () => {
    const { db } = await import("@workspace/db");
    const existingUserField = {
      monthlyCostGbp: { value: 39.99, source: "user" },
      provider: { value: "BT", source: "user" },
    };

    // route: (1) service, (2) extraction, (3) getOrCreateDeal
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]))
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: existingUserField, lastConfirmedAt: null, updatedAt: new Date(),
      }]));

    let savedFields: unknown = null;
    vi.mocked(db.update)
      .mockReturnValueOnce({
        // Capture .set() argument so we can assert on the merged fields
        set: vi.fn().mockImplementation((vals: { fields: unknown }) => {
          savedFields = vals.fields;
          return makeChain([{
            serviceId: 1, fields: vals.fields, lastConfirmedAt: new Date(), updatedAt: new Date(),
          }]);
        }),
      } as never)
      .mockReturnValueOnce(makeChain([])); // confirmedCount update on extractions table

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        confirmedFields: {},
        // User rejects extracted monthlyCostGbp — existing user-entered value must survive
        deletedFields: ["monthlyCostGbp"],
      });

    expect(res.status).toBe(200);
    expect(savedFields).not.toBeNull();
    const saved = savedFields as Record<string, { value: unknown; source: string }>;
    // Existing user-entered value is preserved — deletion only discards the draft
    expect(saved["monthlyCostGbp"]).toBeDefined();
    expect(saved["monthlyCostGbp"]!.source).toBe("user");
    expect(saved["monthlyCostGbp"]!.value).toBe(39.99);
    // provider was not in the draft and remains untouched
    expect(saved["provider"]!.source).toBe("user");
  });

  it("confirming a draft field replaces a pre-existing user-entered value (explicit approval)", async () => {
    const { db } = await import("@workspace/db");
    const existingUserField = { monthlyCostGbp: { value: 39.99, source: "user" } };

    // route: (1) service, (2) extraction, (3) getOrCreateDeal
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]))
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: existingUserField, lastConfirmedAt: null, updatedAt: new Date(),
      }]));

    let savedFields: unknown = null;
    vi.mocked(db.update)
      .mockReturnValueOnce({
        set: vi.fn().mockImplementation((vals: { fields: unknown }) => {
          savedFields = vals.fields;
          return makeChain([{
            serviceId: 1, fields: vals.fields, lastConfirmedAt: new Date(), updatedAt: new Date(),
          }]);
        }),
      } as never)
      .mockReturnValueOnce(makeChain([])); // confirmedCount update

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // User reviewed the document and confirmed a new monthly cost
        confirmedFields: { monthlyCostGbp: { value: 45.99, source: "extracted_confirmed" } },
        deletedFields: [],
      });

    expect(res.status).toBe(200);
    expect(savedFields).not.toBeNull();
    const saved = savedFields as Record<string, { value: unknown; source: string }>;
    // Confirmed value wins — user explicitly approved it from the document
    expect(saved["monthlyCostGbp"]!.value).toBe(45.99);
    expect(saved["monthlyCostGbp"]!.source).toBe("extracted_confirmed");
  });
});

// ─── Household profile — partial PATCH semantics ─────────────────────────────

describe("PUT /api/household-profile — partial PATCH semantics", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app).put("/api/household-profile").send({ postcode: "SW1A1AA" });
    expect(res.status).toBe(401);
  });

  it("persists only the supplied field, leaving other columns untouched", async () => {
    const { db } = await import("@workspace/db");
    // The upserted row the DB returns after INSERT … ON CONFLICT DO UPDATE
    const upsertedProfile = {
      id: 1, postcode: "SW1A1AA", propertyType: null, tenure: null,
      bedrooms: null, yearBuilt: null, numAdults: null, numChildren: null,
      heatingType: null, hasEv: null, evChargerType: null,
      hasSolar: null, solarExportTariff: null,
      annualElectricityKwh: null, annualGasKwh: null,
      hasSkyTv: null, hasSkyMobile: null, hasVirginMedia: null,
      numCars: null, carMake: null, carModel: null, carYear: null,
      carValuePence: null, annualMileage: null, drivingExperience: null,
      claimsLast5Years: null, smoker: null,
      accessibilityNeeds: null, generalPreferences: null,
      questionnaireVersion: "1",
      updatedAt: new Date(), createdAt: new Date(),
    };

    // Route uses INSERT … ON CONFLICT DO UPDATE (atomic upsert).
    // Capture the set values passed to onConflictDoUpdate.
    let capturedSet: Record<string, unknown> = {};
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockImplementation(({ set }: { set: Record<string, unknown> }) => {
          capturedSet = set;
          return {
            returning: vi.fn().mockResolvedValue([upsertedProfile]),
          };
        }),
      }),
    } as never);

    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ postcode: "SW1A1AA" }); // only send one field

    expect(res.status).toBe(200);
    // The conflict-update set must contain only the supplied field + updatedAt
    expect(capturedSet).toHaveProperty("postcode", "SW1A1AA");
    // No other profile columns were included in the conflict update
    const setKeys = Object.keys(capturedSet);
    expect(setKeys.filter((k) => k !== "postcode" && k !== "updatedAt").length).toBe(0);
  });
});

// ─── Extraction replay prevention ─────────────────────────────────────────────

describe("extraction replay prevention", () => {
  it("returns 409 when trying to confirm an already-applied extraction draft", async () => {
    const { db } = await import("@workspace/db");
    const mockService = { id: 1, serviceType: "Broadband", provider: "BT" };
    const consumedExtraction = {
      id: 10,
      serviceId: 1,
      extractionId: "already-used-uuid",
      fieldCount: 1,
      confirmedCount: 1,
      draftFieldKeys: ["monthlyCostGbp"],
      extractedAt: new Date(),
      deletedAt: new Date(), // already consumed
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([consumedExtraction]));

    const res = await request(app)
      .put("/api/services/1/extraction-draft/already-used-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been applied/i);
  });
});

// ─── completeness.ts unit coverage ───────────────────────────────────────────

describe("completeness check does not fill in missing profile fields", () => {
  it("reports car insurance as blocking when household profile is empty", async () => {
    const { checkCompleteness } = await import("../src/lib/completeness");
    const { db } = await import("@workspace/db");

    const mockService = {
      id: 1, serviceType: "Car insurance", provider: "Admiral", active: true,
    };

    // checkCompleteness: (1) service, (2) profile, (3) requirements, (4) deal
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([]))  // empty profile
      .mockReturnValueOnce(makeChain([]))  // requirements
      .mockReturnValueOnce(makeChain([])); // deal

    const report = await checkCompleteness(1);
    expect(report.blocking).toBe(true);
    expect(report.required).toContain("Car make");
    expect(report.required).toContain("Car model");
    expect(report.required).toContain("Car year");
  });
});
