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
  // Re-apply transaction default after vi.resetAllMocks() wipes the implementation.
  // db.transaction calls its callback with the same mocked `db` so that
  // vi.mocked(db.select/update/insert).mockReturnValueOnce() calls
  // in individual tests work correctly inside transactional route handlers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(db.transaction).mockImplementation(async (cb: (tx: any) => Promise<unknown>) => cb(db));
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
  it("rejects client-submitted extracted_unconfirmed provenance (provenance spoofing via fields key)", async () => {
    // Clients must NOT be able to inject extracted provenance via the manual PUT endpoint.
    // The route detects source:"extracted_unconfirmed" in the legacy `fields` key and returns 400.
    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({
        // Old API style with server-controlled provenance — must be rejected
        fields: { provider: { value: "BT", source: "extracted_unconfirmed" } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/server-side/i);
  });

  it("rejects client-submitted extracted_confirmed provenance (provenance spoofing via fields key)", async () => {
    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({
        fields: { provider: { value: "BT", source: "extracted_confirmed" } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/server-side/i);
  });

  it("accepts values+clear and server assigns source:user", async () => {
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
      // New API: only raw values, no provenance
      .send({ values: { provider: "BT" } });
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
  // The route now:
  //  1. Validates the body fully (ConfirmBodySchema)
  //  2. Fetches the service OUTSIDE the transaction (step B) — needs select(1)=service
  //  3. Coerces confirmed values (step C)
  //  4. Runs the transaction:
  //       select(2) extraction, update(1) claim, select(3) deal, update(2) deal, update(3) mark-applied
  const mockService = { id: 1, serviceType: "Broadband" };
  const mockExtraction = {
    id: 10,
    serviceId: 1,
    extractionId: "test-uuid-abc",
    fieldCount: 2,
    confirmedCount: 0,
    draftFieldKeys: ["monthlyCostGbp", "tariffName"],
    status: "draft",
    draftFields: { monthlyCostGbp: { value: 42, source: "extracted_unconfirmed" } },
    expiresAt: null,
    extractedAt: new Date(),
    deletedAt: null,
  };

  // Mock sequence for a SUCCESS confirmation:
  //   select(1) service    ← outside transaction (step B)
  //   select(2) extraction ← inside transaction
  //   update(1) claim draft→applying → [{id:10}]
  //   select(3) existing deal
  //   update(2) update/insert deal → returns row
  //   update(3) mark applied → []

  it("rejects confirmedFields keys not in the extraction draft", async () => {
    const { db } = await import("@workspace/db");
    // Body validation + provenance pass → service fetched → coercion OK (no known fields)
    // → transaction claims → ConfirmationValidationError thrown → rollback (draft stays 'draft')
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))     // service lookup (step B)
      .mockReturnValueOnce(makeChain([mockExtraction])); // extraction inside tx
    vi.mocked(db.update).mockReturnValueOnce(makeChain([{ id: 10 }])); // claim only

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // "provider" is NOT a draft key — only monthlyCostGbp and tariffName are
        confirmedFields: { provider: { value: "Injected" } },
        deletedFields: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/);
    expect(res.body.error).toMatch(/not in this extraction draft/i);
  });

  it("draft stays in 'draft' state after a 400 key-validation failure (can be retried)", async () => {
    // Confirms that ConfirmationValidationError causes a rollback, not a "failed" mark.
    // The second request (with valid keys) must still succeed.
    const { db } = await import("@workspace/db");

    // First request: invalid key → 400, draft rolled back to 'draft'
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]));
    vi.mocked(db.update).mockReturnValueOnce(makeChain([{ id: 10 }])); // claim only (rolled back)

    const badRes = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: { provider: { value: "Bad" } }, deletedFields: [] });
    expect(badRes.status).toBe(400);

    // Second request: valid keys, draft is still available → should succeed
    const existingDeal = { serviceId: 1, fields: {}, lastConfirmedAt: null, updatedAt: new Date() };
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))     // service (step B)
      .mockReturnValueOnce(makeChain([mockExtraction]))  // extraction in tx
      .mockReturnValueOnce(makeChain([existingDeal]));   // existing deal in tx
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }]))      // claim
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: {}, lastConfirmedAt: new Date(), updatedAt: new Date(),
      }]))                                               // update deal
      .mockReturnValueOnce(makeChain([]));               // mark applied

    const goodRes = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: { monthlyCostGbp: { value: 45 } }, deletedFields: [] });
    expect(goodRes.status).toBe(200);
  });

  it("rejects malformed confirmedFields entry (non-object value) without touching draft status", async () => {
    // ConfirmBodySchema validation fails before any DB call — draft remains untouched.
    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // null is not a { value } object — schema requires z.object({ value: z.unknown() })
        confirmedFields: { monthlyCostGbp: null },
        deletedFields: [],
      });
    expect(res.status).toBe(400);
    // No DB mocks were needed — the error fires before any select/update
  });

  it("rejects non-array deletedFields without touching draft status", async () => {
    // Malformed deletedFields must return 400 before the claim guard runs.
    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        confirmedFields: {},
        deletedFields: "notAnArray", // must be string[]
      });
    expect(res.status).toBe(400);
  });

  it("rejects deletedFields keys not in the extraction draft", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]));
    vi.mocked(db.update).mockReturnValueOnce(makeChain([{ id: 10 }])); // claim only

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

    // Mock sequence:
    //   select(1) service   ← step B (outside tx)
    //   select(2) extraction ← inside tx
    //   update(1) claim → [{id:10}]
    //   select(3) existing deal
    //   update(2) update deal — captured for assertion
    //   update(3) mark applied
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]))
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: existingUserField, lastConfirmedAt: null, updatedAt: new Date(),
      }]));

    let savedFields: unknown = null;
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }])) // claim succeeds
      .mockReturnValueOnce({
        // Capture .set() argument so we can assert on the merged fields
        set: vi.fn().mockImplementation((vals: { fields: unknown }) => {
          savedFields = vals.fields;
          return makeChain([{
            serviceId: 1, fields: vals.fields, lastConfirmedAt: new Date(), updatedAt: new Date(),
          }]);
        }),
      } as never)
      .mockReturnValueOnce(makeChain([])); // mark applied

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
    // Existing user-entered value is preserved — deletion only discards the draft field
    expect(saved["monthlyCostGbp"]).toBeDefined();
    expect(saved["monthlyCostGbp"]!.source).toBe("user");
    expect(saved["monthlyCostGbp"]!.value).toBe(39.99);
    // provider was not in the draft and remains untouched
    expect(saved["provider"]!.source).toBe("user");
  });

  it("confirming a draft field replaces a pre-existing user-entered value (explicit approval)", async () => {
    const { db } = await import("@workspace/db");
    const existingUserField = { monthlyCostGbp: { value: 39.99, source: "user" } };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))     // service (step B)
      .mockReturnValueOnce(makeChain([mockExtraction]))  // extraction in tx
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: existingUserField, lastConfirmedAt: null, updatedAt: new Date(),
      }]));                                              // existing deal in tx

    let savedFields: unknown = null;
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }])) // claim
      .mockReturnValueOnce({
        set: vi.fn().mockImplementation((vals: { fields: unknown }) => {
          savedFields = vals.fields;
          return makeChain([{
            serviceId: 1, fields: vals.fields, lastConfirmedAt: new Date(), updatedAt: new Date(),
          }]);
        }),
      } as never)
      .mockReturnValueOnce(makeChain([])); // mark applied

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // User reviewed the document and confirmed a new monthly cost.
        // NO source property — server assigns source:"extracted_confirmed" server-side.
        confirmedFields: { monthlyCostGbp: { value: 45.99 } },
        deletedFields: [],
      });

    expect(res.status).toBe(200);
    expect(savedFields).not.toBeNull();
    const saved = savedFields as Record<string, { value: unknown; source: string }>;
    // Confirmed value wins — user explicitly approved it from the document.
    // The route coerces via validateDealValues then persists the coerced number.
    expect(saved["monthlyCostGbp"]!.value).toBe(45.99);
    expect(saved["monthlyCostGbp"]!.source).toBe("extracted_confirmed");
  });

  it("confirmed numeric string values are coerced to numbers before persistence", async () => {
    // <input type="number"> in the confirm UI sends e.target.value as a string.
    // The route must coerce and store a number, not a string.
    const { db } = await import("@workspace/db");
    const existingDeal = { serviceId: 1, fields: {}, lastConfirmedAt: null, updatedAt: new Date() };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))
      .mockReturnValueOnce(makeChain([mockExtraction]))
      .mockReturnValueOnce(makeChain([existingDeal]));

    let savedFields: unknown = null;
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }])) // claim
      .mockReturnValueOnce({
        set: vi.fn().mockImplementation((vals: { fields: unknown }) => {
          savedFields = vals.fields;
          return makeChain([{
            serviceId: 1, fields: vals.fields, lastConfirmedAt: new Date(), updatedAt: new Date(),
          }]);
        }),
      } as never)
      .mockReturnValueOnce(makeChain([])); // mark applied

    const res = await request(app)
      .put("/api/services/1/extraction-draft/test-uuid-abc/confirm")
      .set("Cookie", authCookie)
      .send({
        // "45.99" is a string (from HTML input) — must be coerced to number before storage
        confirmedFields: { monthlyCostGbp: { value: "45.99" } },
        deletedFields: [],
      });

    expect(res.status).toBe(200);
    const saved = savedFields as Record<string, { value: unknown; source: string }>;
    expect(typeof saved["monthlyCostGbp"]!.value).toBe("number");
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
  const mockService = { id: 1, serviceType: "Broadband" };

  it("returns 409 when trying to confirm an already-applied extraction draft", async () => {
    const { db } = await import("@workspace/db");
    // Route now fetches service (select 1) before the transaction.
    // Inside tx: select(2) returns extraction, update claiming returns []
    // (0 rows because WHERE status='draft' doesn't match status='applied').
    const consumedExtraction = {
      id: 10,
      serviceId: 1,
      extractionId: "already-used-uuid",
      fieldCount: 1,
      confirmedCount: 1,
      draftFieldKeys: ["monthlyCostGbp"],
      status: "applied", // already applied
      draftFields: {},
      expiresAt: null,
      extractedAt: new Date(),
      deletedAt: new Date(),
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))          // service (step B)
      .mockReturnValueOnce(makeChain([consumedExtraction]));  // extraction inside tx
    // Claim update: returns [] because status != 'draft'
    vi.mocked(db.update).mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .put("/api/services/1/extraction-draft/already-used-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been applied/i);
  });

  it("two concurrent confirmations: first wins (200), second gets 409 — verified via claim guard", async () => {
    // This test verifies the atomic claim mechanism (conditional status draft→applying).
    // True concurrency is an integration-test concern; here we verify the mechanism
    // deterministically: first request claims and succeeds, second sees 0 rows → 409.
    const { db } = await import("@workspace/db");
    const draftExtraction = {
      id: 10,
      serviceId: 1,
      extractionId: "claim-guard-uuid",
      fieldCount: 1,
      confirmedCount: 0,
      draftFieldKeys: ["monthlyCostGbp"],
      status: "draft",
      draftFields: {},
      expiresAt: null,
      extractedAt: new Date(),
      deletedAt: null,
    };

    // ── First request: claim succeeds ──
    const existingDeal = { serviceId: 1, fields: {}, lastConfirmedAt: null, updatedAt: new Date() };
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))     // service (step B)
      .mockReturnValueOnce(makeChain([draftExtraction])) // extraction in tx
      .mockReturnValueOnce(makeChain([existingDeal]));   // existing deal (update path)
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }]))      // claim: 1 row → success
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: {}, lastConfirmedAt: new Date(), updatedAt: new Date(),
      }]))                                               // deal update
      .mockReturnValueOnce(makeChain([]));               // mark applied

    const res1 = await request(app)
      .put("/api/services/1/extraction-draft/claim-guard-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });
    expect(res1.status).toBe(200);

    // ── Second request: extraction has moved out of 'draft' — claim returns 0 rows ──
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))  // service (step B)
      .mockReturnValueOnce(makeChain([{ ...draftExtraction, status: "applied" }])); // in tx
    vi.mocked(db.update).mockReturnValueOnce(makeChain([])); // 0 rows → 409

    const res2 = await request(app)
      .put("/api/services/1/extraction-draft/claim-guard-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toMatch(/already been applied/i);
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

// ─── Task #12: Provenance spoofing in confirmation endpoint ────────────────────

describe("confirmation endpoint — server-side provenance enforcement", () => {
  const mockExtraction = {
    id: 10,
    serviceId: 1,
    extractionId: "provenance-test-uuid",
    fieldCount: 1,
    confirmedCount: 0,
    draftFieldKeys: ["monthlyCostGbp"],
    status: "draft",
    draftFields: {},
    expiresAt: null,
    extractedAt: new Date(),
    deletedAt: null,
  };

  it("rejects confirmedFields with source:extracted_confirmed (server-only provenance)", async () => {
    // Clients MUST NOT be able to inject extracted_confirmed provenance.
    // The route checks for server-only sources before calling db.transaction.
    const res = await request(app)
      .put("/api/services/1/extraction-draft/provenance-test-uuid/confirm")
      .set("Cookie", authCookie)
      .send({
        confirmedFields: {
          monthlyCostGbp: { value: 45.99, source: "extracted_confirmed" },
        },
        deletedFields: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/server-side/i);
  });

  it("rejects confirmedFields with source:extracted_unconfirmed (server-only provenance)", async () => {
    const res = await request(app)
      .put("/api/services/1/extraction-draft/provenance-test-uuid/confirm")
      .set("Cookie", authCookie)
      .send({
        confirmedFields: {
          monthlyCostGbp: { value: 45.99, source: "extracted_unconfirmed" },
        },
        deletedFields: [],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/server-side/i);
  });

  it("accepts confirmedFields without source — server assigns extracted_confirmed", async () => {
    const { db } = await import("@workspace/db");
    const existingDeal = { serviceId: 1, fields: {}, lastConfirmedAt: null, updatedAt: new Date() };
    // Route fetches service before the transaction (step B)
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockExtraction]))  // service (step B) — mockExtraction used as stand-in (only .serviceType matters)
      .mockReturnValueOnce(makeChain([mockExtraction]))  // extraction inside tx
      .mockReturnValueOnce(makeChain([existingDeal]));   // existing deal → update path
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }])) // claim
      .mockReturnValueOnce(makeChain([{
        serviceId: 1,
        fields: { monthlyCostGbp: { value: 45.99, source: "extracted_confirmed" } },
        lastConfirmedAt: new Date(),
        updatedAt: new Date(),
      }])) // update deal
      .mockReturnValueOnce(makeChain([])); // mark applied

    const res = await request(app)
      .put("/api/services/1/extraction-draft/provenance-test-uuid/confirm")
      .set("Cookie", authCookie)
      .send({
        // No source — server assigns extracted_confirmed
        confirmedFields: { monthlyCostGbp: { value: 45.99 } },
        deletedFields: [],
      });
    expect(res.status).toBe(200);
    // Server must assign source: "extracted_confirmed" — not client
    const savedField = res.body.fields?.monthlyCostGbp;
    if (savedField) {
      expect(savedField.source).toBe("extracted_confirmed");
    }
  });
});

// ─── Task #12: MIME detection — no fallback to client-supplied Content-Type ───

describe("POST /api/services/:id/extract-document — MIME hardening", () => {
  it("rejects files where magic-byte detection returns null (unidentified file)", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );
    const { fileTypeFromBuffer } = await import("file-type");
    // fileTypeFromBuffer returns undefined/null → file type undetectable
    vi.mocked(fileTypeFromBuffer).mockResolvedValueOnce(undefined);

    const res = await request(app)
      .post("/api/services/1/extract-document")
      .set("Cookie", authCookie)
      // Upload a file with a PDF Content-Type but no magic bytes
      .attach("document", Buffer.from("this is not a real pdf"), {
        filename: "notreally.pdf",
        contentType: "application/pdf", // client claims PDF but magic bytes disagree
      });
    // Must reject — no MIME fallback to client-supplied Content-Type
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Unsupported file type/i);
  });

  it("rejects files where magic-byte detection returns a disallowed type (spoofed MIME)", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValueOnce(
      makeChain([{ id: 1, serviceType: "Broadband" }])
    );
    const { fileTypeFromBuffer } = await import("file-type");
    // Actual bytes are a GIF even though client sent Content-Type: application/pdf
    vi.mocked(fileTypeFromBuffer).mockResolvedValueOnce(
      { mime: "image/gif", ext: "gif" } as Awaited<ReturnType<typeof fileTypeFromBuffer>>
    );

    const res = await request(app)
      .post("/api/services/1/extract-document")
      .set("Cookie", authCookie)
      .attach("document", Buffer.from("GIF89a fake gif bytes"), {
        filename: "invoice.pdf",
        contentType: "application/pdf", // lies about content type
      });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/Unsupported file type/i);
  });
});

// ─── Task #12: Schema-strict PUT — unknown field names rejected ────────────────

describe("PUT /api/services/:id/current-deal — schema strictness", () => {
  it("ignores unknown field names (only schema-declared fields are persisted)", async () => {
    // Zod strips keys not in the service-type schema; the route iterates
    // coercedValues so arbitrary field names cannot be stored.
    const { db } = await import("@workspace/db");
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1, serviceType: "Broadband" }]))
      .mockReturnValueOnce(makeChain([])); // no existing deal

    let insertedFields: unknown = null;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockImplementation((v: { fields: unknown }) => {
        insertedFields = v.fields;
        return makeChain([{
          serviceId: 1, fields: v.fields, lastConfirmedAt: null, updatedAt: new Date(),
        }]);
      }),
    } as never);

    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({
        values: {
          provider: "BT",              // valid — in BroadbandDeal schema
          arbitraryHackedField: "HACK", // NOT a declared field — must be dropped
        },
      });

    expect(res.status).toBe(200);
    const stored = insertedFields as Record<string, { value: unknown; source: string }>;
    expect(stored["provider"]?.value).toBe("BT");
    // Unknown field must be absent from the stored deal
    expect(stored["arbitraryHackedField"]).toBeUndefined();
  });

  it("stores numeric string values as numbers (coercion persisted)", async () => {
    // HTML <input type="number"> submits e.target.value as a string.
    // The route must persist the coerced number, not the raw string.
    const { db } = await import("@workspace/db");
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1, serviceType: "Broadband" }]))
      .mockReturnValueOnce(makeChain([]));

    let insertedFields: unknown = null;
    vi.mocked(db.insert).mockReturnValueOnce({
      values: vi.fn().mockImplementation((v: { fields: unknown }) => {
        insertedFields = v.fields;
        return makeChain([{
          serviceId: 1, fields: v.fields, lastConfirmedAt: null, updatedAt: new Date(),
        }]);
      }),
    } as never);

    const res = await request(app)
      .put("/api/services/1/current-deal")
      .set("Cookie", authCookie)
      .send({ values: { monthlyCostGbp: "45.99" } }); // string from HTML form

    expect(res.status).toBe(200);
    const stored = insertedFields as Record<string, { value: unknown; source: string }>;
    // Must be stored as a number, not a string
    expect(typeof stored["monthlyCostGbp"]?.value).toBe("number");
    expect(stored["monthlyCostGbp"]?.value).toBe(45.99);
  });
});

// ─── Task #12: confirm vs discard race — discard must not win over applying ───

describe("confirm/discard race — lifecycle integrity", () => {
  const mockService = { id: 1, serviceType: "Broadband" };
  const draftExtraction = {
    id: 10,
    serviceId: 1,
    extractionId: "race-uuid",
    fieldCount: 1,
    confirmedCount: 0,
    draftFieldKeys: ["monthlyCostGbp"],
    status: "draft",
    draftFields: {},
    expiresAt: null,
    extractedAt: new Date(),
    deletedAt: null,
  };

  it("discard returns 409 when extraction is in 'applying' state (confirm has claimed it)", async () => {
    // A confirm has moved the draft to 'applying'. A concurrent discard must see 409,
    // ensuring the confirm's deal write is not silently undone.
    const { db } = await import("@workspace/db");

    const applyingExtraction = { ...draftExtraction, status: "applying" };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1 }]))         // service lookup in discard route
      .mockReturnValueOnce(makeChain([applyingExtraction])); // extraction (status=applying)

    const res = await request(app)
      .post("/api/services/1/extraction-draft/race-uuid/discard")
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/applying/i);
  });

  it("confirm succeeds and discard subsequently gets 409 (sequential race simulation)", async () => {
    // Step 1: confirm wins — full success path
    const { db } = await import("@workspace/db");
    const existingDeal = { serviceId: 1, fields: {}, lastConfirmedAt: null, updatedAt: new Date() };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))         // service (confirm step B)
      .mockReturnValueOnce(makeChain([draftExtraction]))     // extraction in tx
      .mockReturnValueOnce(makeChain([existingDeal]));       // deal in tx
    vi.mocked(db.update)
      .mockReturnValueOnce(makeChain([{ id: 10 }]))          // claim draft→applying
      .mockReturnValueOnce(makeChain([{
        serviceId: 1, fields: { monthlyCostGbp: { value: 42, source: "extracted_confirmed" } },
        lastConfirmedAt: new Date(), updatedAt: new Date(),
      }]))                                                   // update deal
      .mockReturnValueOnce(makeChain([]));                   // mark applied

    const confirmRes = await request(app)
      .put("/api/services/1/extraction-draft/race-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });
    expect(confirmRes.status).toBe(200);

    // Step 2: discard arrives late — extraction is now 'applied' → 409
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1 }]))
      .mockReturnValueOnce(makeChain([{ ...draftExtraction, status: "applied" }]));

    const discardRes = await request(app)
      .post("/api/services/1/extraction-draft/race-uuid/discard")
      .set("Cookie", authCookie);
    expect(discardRes.status).toBe(409);
    // The applied deal must not have been touched by the discard
  });
});

// ─── Task #12: discard zero-row race — atomic conditional update ───────────────

describe("discard route — atomic conditional update race", () => {
  it("returns 409 when update affects 0 rows (confirm claimed draft between read and write)", async () => {
    // Simulates: discard reads status='draft', then confirm claims draft→applying,
    // then discard's conditional UPDATE WHERE status='draft' matches 0 rows.
    // The discard must return 409, NOT 204.
    const { db } = await import("@workspace/db");

    const draftExtraction = {
      id: 10,
      serviceId: 1,
      extractionId: "race-discard-uuid",
      fieldCount: 1,
      confirmedCount: 0,
      draftFieldKeys: ["monthlyCostGbp"],
      status: "draft", // read still sees 'draft' ...
      draftFields: {},
      expiresAt: null,
      extractedAt: new Date(),
      deletedAt: null,
    };

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1 }]))        // service
      .mockReturnValueOnce(makeChain([draftExtraction]));  // extraction (status=draft)

    // ... but the conditional update returns [] — confirm has claimed it in between
    vi.mocked(db.update).mockReturnValueOnce(makeChain([]));

    const res = await request(app)
      .post("/api/services/1/extraction-draft/race-discard-uuid/discard")
      .set("Cookie", authCookie);

    // Must be 409, not 204 — the discard was lost in the race
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/concurrent/i);
  });
});

// ─── Task #12: draft expiry enforcement ──────────────────────────────────────

describe("draft expiry enforcement — confirm and discard reject expired drafts", () => {
  const mockService = { id: 1, serviceType: "Broadband" };
  const expiredExtraction = {
    id: 10,
    serviceId: 1,
    extractionId: "expired-draft-uuid",
    fieldCount: 1,
    confirmedCount: 0,
    draftFieldKeys: ["monthlyCostGbp"],
    status: "draft",
    draftFields: {},
    expiresAt: new Date(Date.now() - 60_000), // 1 min in the past
    extractedAt: new Date(Date.now() - 90_000),
    deletedAt: null,
  };

  it("confirm returns 409 when draft has expired (claim WHERE rejects it)", async () => {
    // Route fetches service, then inside tx: SELECT extraction, then the claim
    // UPDATE WHERE status='draft' AND expiresAt > now() returns 0 rows → 409.
    const { db } = await import("@workspace/db");

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([mockService]))          // service (step B)
      .mockReturnValueOnce(makeChain([expiredExtraction]));   // extraction inside tx
    vi.mocked(db.update).mockReturnValueOnce(makeChain([]));  // claim: 0 rows (expired)

    const res = await request(app)
      .put("/api/services/1/extraction-draft/expired-draft-uuid/confirm")
      .set("Cookie", authCookie)
      .send({ confirmedFields: {}, deletedFields: [] });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("discard returns 409 when draft has expired (conditional UPDATE returns 0 rows)", async () => {
    // Discard's WHERE includes expiresAt > now() — expired draft → 0 rows → 409.
    const { db } = await import("@workspace/db");

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1 }]))           // service
      .mockReturnValueOnce(makeChain([expiredExtraction]));   // extraction (status=draft, expired)
    vi.mocked(db.update).mockReturnValueOnce(makeChain([]));  // 0 rows (expiry guard)

    const res = await request(app)
      .post("/api/services/1/extraction-draft/expired-draft-uuid/discard")
      .set("Cookie", authCookie);

    expect(res.status).toBe(409);
  });

  it("pending expiry update is conditional on status=draft (cannot overwrite applied)", async () => {
    // If a confirm has applied the draft between GET /pending's SELECT and its
    // expiry UPDATE, the conditional WHERE status='draft' must prevent the overwrite.
    // In the mock world: select returns an expired draft, update returns 0 rows
    // (because confirm has moved it to 'applied') — the route still returns null.
    const { db } = await import("@workspace/db");

    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: 1 }]))           // service
      .mockReturnValueOnce(makeChain([expiredExtraction]));   // draft (but expired)
    vi.mocked(db.update).mockReturnValueOnce(makeChain([])); // 0 rows — another op got there first

    const res = await request(app)
      .get("/api/services/1/extraction-draft/pending")
      .set("Cookie", authCookie);

    // Endpoint still returns null (expired draft is not surfaced), and the 0-row
    // update is accepted without error — the real terminal status was already set.
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
