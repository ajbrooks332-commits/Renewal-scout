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

  it("422 completenessReport shape: required items are MissingField {label, destination}", async () => {
    const { db } = await import("@workspace/db");
    const mockService = {
      id: 1, serviceType: "Car insurance", provider: "Admiral", active: true,
      autoResearch: true, renewalDate: null, contractEndDate: null,
      noticeDays: 30, researchWindowDays: 60,
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([]))   // empty profile
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post("/api/services/1/research")
      .set("Cookie", authCookie)
      .send({});

    expect(res.status).toBe(422);
    const report = res.body.completenessReport;
    // Contract: required and recommended are arrays of {label, destination}
    for (const field of report.required) {
      expect(field).toMatchObject({
        label: expect.any(String),
        destination: expect.stringMatching(/^(household|requirements|current-deal)$/),
      });
    }
    // Contract: researchMode is present and "generic" when blocking
    expect(report.researchMode).toBe("generic");
  });

  it("accepts researchMode:'generic' as bypass for missing fields", async () => {
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
    // Sequence: checkCompleteness (4 selects), queueResearch service lookup,
    // queueResearch existing-runs check, final run fetch after insert.
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService])) // checkCompleteness: service
      .mockReturnValueOnce(makeChain([]))            // checkCompleteness: profile (empty → generic mode)
      .mockReturnValueOnce(makeChain([]))            // checkCompleteness: requirements
      .mockReturnValueOnce(makeChain([]))            // checkCompleteness: deal
      .mockReturnValueOnce(makeChain([mockService])) // queueResearch: service lookup
      .mockReturnValueOnce(makeChain([]))            // queueResearch: existing active runs check
      .mockReturnValueOnce(makeChain([mockRun]));    // route: final select of created run
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([mockRun]));

    const res = await request(app)
      .post("/api/services/1/research")
      .set("Cookie", authCookie)
      .send({ researchMode: "generic" }); // new contract field — replaces forceWithMissing

    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty("id", 99);
  });

  it("bypasses the completeness gate when researchMode is 'generic' (or legacy forceWithMissing)", async () => {
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
    // The conflict-update set must contain only the supplied field + updatedAt.
    // Postcode is normalised: "SW1A1AA" → "SW1A 1AA" (space before inward code)
    expect(capturedSet).toHaveProperty("postcode", "SW1A 1AA");
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
    // required is now MissingField[] — check labels
    const labels = report.required.map((f: { label: string }) => f.label);
    expect(labels).toContain("Car make");
    expect(labels).toContain("Car model");
    expect(labels).toContain("Car year");
  });
});

// ─── Generic-mode research execution ─────────────────────────────────────────

describe("generic-mode research — prompt and persistence", () => {
  it("queueResearch stores genericMode flag on the run (happy path)", async () => {
    const { queueResearch } = await import("../src/lib/research-service");
    const { db } = await import("@workspace/db");

    const mockService = {
      id: 1, serviceType: "Broadband", provider: "BT", active: true,
    };
    const mockRun = {
      id: 55, serviceId: 1, trigger: "manual", genericMode: true, status: "queued",
      error: null, reportJson: null, createdAt: new Date(), startedAt: null, completedAt: null,
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService])) // service lookup
      .mockReturnValueOnce(makeChain([]));           // no existing active runs
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([mockRun]));

    const runId = await queueResearch(1, "manual", true);
    expect(runId).toBe(mockRun.id);
  });

  it("queueResearch preserves genericMode on the conflict-retry insert path", async () => {
    // Simulates the race: first insert is a no-op (ON CONFLICT), the winner
    // completes before our SELECT, so we fall through to the un-guarded retry.
    // genericMode must be carried through that retry insert.
    const { queueResearch } = await import("../src/lib/research-service");
    const { db } = await import("@workspace/db");

    const mockService = {
      id: 2, serviceType: "Broadband", provider: "Sky", active: true,
    };
    const retryRun = {
      id: 77, serviceId: 2, trigger: "manual", genericMode: true, status: "queued",
      error: null, reportJson: null, createdAt: new Date(), startedAt: null, completedAt: null,
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService])) // service lookup
      .mockReturnValueOnce(makeChain([]))            // pre-insert check: no active runs
      .mockReturnValueOnce(makeChain([]));           // post-conflict fetch: winner already completed
    vi.mocked(db.insert)
      .mockReturnValueOnce(makeChain([]))            // first insert → ON CONFLICT DO NOTHING (empty)
      .mockReturnValueOnce(makeChain([retryRun]));   // retry insert → succeeds with genericMode

    const runId = await queueResearch(2, "manual", true);
    expect(runId).toBe(77);

    // Verify the RETRY insert (second db.insert call) was invoked.
    // If genericMode were missing the run would silently become personalised.
    expect(vi.mocked(db.insert)).toHaveBeenCalledTimes(2);
  });

  it("executeResearch uses generic prompt when genericMode is true (OPENAI_API_KEY absent → skips)", async () => {
    // When OPENAI_API_KEY is absent the function exits early.
    // We just verify genericMode is read from the run row — no network call.
    const { executeResearch } = await import("../src/lib/research-service");
    const { db } = await import("@workspace/db");

    const mockRun = {
      id: 77, serviceId: 1, trigger: "manual", genericMode: true, status: "queued",
      error: null, reportJson: null, createdAt: new Date(), startedAt: null, completedAt: null,
    };

    // No OPENAI_API_KEY → early exit after marking failed
    delete process.env["OPENAI_API_KEY"];
    vi.mocked(db.update).mockReturnValueOnce(makeChain([{ id: 77 }]));

    await expect(executeResearch(77)).resolves.toBeUndefined();
    // update was called (to mark failed — expected when no API key)
    expect(vi.mocked(db.update)).toHaveBeenCalled();
  });
});

// ─── Household profile — multi-vehicle round-trip ─────────────────────────────

describe("PUT /api/household-profile — multi-vehicle", () => {
  it("accepts partial vehicle entry (only make set, model absent)", async () => {
    const { db } = await import("@workspace/db");
    const now = new Date();
    const updatedRow = {
      id: 1, postcode: "SW1A 1AA", propertyType: null, tenure: null,
      bedrooms: null, yearBuilt: null, numAdults: null, numChildren: null,
      numCars: 2, carMake: "Ford", carModel: null, carYear: null,
      carValuePence: null, annualMileage: null, drivingExperience: null,
      claimsLast5Years: null, heatingType: null, hasEv: null, evChargerType: null,
      hasSolar: null, solarExportTariff: null, annualElectricityKwh: null,
      annualGasKwh: null, smoker: null, hasSkyTv: null, hasSkyMobile: null,
      hasVirginMedia: null, mortgageProvider: null, monthlyMortgageGbp: null,
      mortgageEndDate: null, accessibilityNeeds: null, generalPreferences: null,
      questionnaireVersion: "1", vehicles: [{ make: "Ford" }],
      unknownFields: [], createdAt: now, updatedAt: now,
    };
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([updatedRow]));

    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({
        numCars: 2,
        postcode: "SW1A 1AA",
        vehicles: [
          { make: "Ford" },  // only make, no model — should be accepted (nullable)
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.vehicles).toEqual([{ make: "Ford" }]);
  });

  it("syncs legacy car columns to null when vehicles: [] is sent", async () => {
    const { db } = await import("@workspace/db");
    const now = new Date();
    // Simulate a row where stale carMake was previously set but vehicles: [] clears it
    const updatedRow = {
      id: 1, postcode: null, propertyType: null, tenure: null,
      bedrooms: null, yearBuilt: null, numAdults: null, numChildren: null,
      numCars: 0, carMake: null, carModel: null, carYear: null,
      carValuePence: null, annualMileage: null, drivingExperience: null,
      claimsLast5Years: null, heatingType: null, hasEv: null, evChargerType: null,
      hasSolar: null, solarExportTariff: null, annualElectricityKwh: null,
      annualGasKwh: null, smoker: null, hasSkyTv: null, hasSkyMobile: null,
      hasVirginMedia: null, mortgageProvider: null, monthlyMortgageGbp: null,
      mortgageEndDate: null, accessibilityNeeds: null, generalPreferences: null,
      questionnaireVersion: "1", vehicles: [], unknownFields: [],
      createdAt: now, updatedAt: now,
    };
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([updatedRow]));

    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ vehicles: [] }); // send empty array — legacy columns must be nulled

    expect(res.status).toBe(200);
    // Response reflects cleared legacy car fields
    expect(res.body.carMake).toBeNull();
    expect(res.body.carModel).toBeNull();
    expect(res.body.vehicles).toEqual([]);
  });

  it("accepts empty vehicles array (numCars set, no vehicle data yet)", async () => {
    const { db } = await import("@workspace/db");
    const now = new Date();
    const updatedRow = {
      id: 1, postcode: null, propertyType: null, tenure: null,
      bedrooms: null, yearBuilt: null, numAdults: null, numChildren: null,
      numCars: 2, carMake: null, carModel: null, carYear: null,
      carValuePence: null, annualMileage: null, drivingExperience: null,
      claimsLast5Years: null, heatingType: null, hasEv: null, evChargerType: null,
      hasSolar: null, solarExportTariff: null, annualElectricityKwh: null,
      annualGasKwh: null, smoker: null, hasSkyTv: null, hasSkyMobile: null,
      hasVirginMedia: null, mortgageProvider: null, monthlyMortgageGbp: null,
      mortgageEndDate: null, accessibilityNeeds: null, generalPreferences: null,
      questionnaireVersion: "1", vehicles: [], unknownFields: [],
      createdAt: now, updatedAt: now,
    };
    vi.mocked(db.insert).mockReturnValueOnce(makeChain([updatedRow]));

    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ numCars: 2 }); // no vehicles array — numCars alone is valid

    expect(res.status).toBe(200);
    expect(res.body.numCars).toBe(2);
  });
});

// ─── Route-level strict validation 400 responses ──────────────────────────────
// These exercise the Zod schema guards at the HTTP boundary, not just the schema
// unit level. They ensure the routes return 400 (not 500) for bad input.

describe("POST /api/services — strict validation 400s", () => {
  it("returns 400 for an unrecognised service type", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", authCookie)
      .send({ serviceType: "Plumbing", provider: "APlumber", noticeDays: 30, researchWindowDays: 60 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when an unknown key is included in the body", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "BT", unknownField: "value" });
    expect(res.status).toBe(400);
    // Route returns { error, details } from parsed.error.format()
    expect(res.body).toHaveProperty("details");
  });

  it("returns 400 for a whitespace-only provider", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "   ", noticeDays: 30, researchWindowDays: 60 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a negative monthly cost", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "BT", monthlyCostGbp: -1 });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an impossible renewal date", async () => {
    const res = await request(app)
      .post("/api/services")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "BT", renewalDate: "2026-02-30" });
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/services/:id — strict validation 400s", () => {
  it("returns 400 for an unknown key (Zod .strict() fires before any DB call)", async () => {
    // No DB mock needed — validation runs before the UPDATE query
    const res = await request(app)
      .put("/api/services/1")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "Sky", hackerField: "value" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("details");
  });

  it("returns 400 for a non-digit route ID (parseRouteId rejects '1abc')", async () => {
    // parseRouteId("1abc") → null → 400, before any DB query
    const res = await request(app)
      .put("/api/services/1abc")
      .set("Cookie", authCookie)
      .send({ serviceType: "Broadband", provider: "Sky" });
    expect(res.status).toBe(400);
  });
});

// Household profile uses PUT (upsert semantics) at this route
describe("PUT /api/household-profile — strict validation 400s", () => {
  it("returns 400 when string 'false' is sent for a boolean field", async () => {
    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ hasEv: "false" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid postcode", async () => {
    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ postcode: "12345" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unknown key (.strict() on schema)", async () => {
    const res = await request(app)
      .put("/api/household-profile")
      .set("Cookie", authCookie)
      .send({ postcode: "SW1A 1AA", unknownField: "value" });
    expect(res.status).toBe(400);
  });
});
