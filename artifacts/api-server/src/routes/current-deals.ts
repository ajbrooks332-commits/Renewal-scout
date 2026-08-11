import { Router, type IRouter } from "express";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  servicesTable,
  currentDealsTable,
  documentExtractionsTable,
} from "@workspace/db";
import { parseRouteId, validateDealValues } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import { randomUUID } from "crypto";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import OpenAI from "openai";
import { z } from "zod";
import { logger } from "../lib/logger";
import rateLimit from "express-rate-limit";

const router: IRouter = Router();
router.use(requireAuth);

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProvenanceSource =
  | "user"
  | "extracted_confirmed"
  | "extracted_unconfirmed"
  | "unknown";

export interface ProvenanceField {
  value: unknown;
  source: ProvenanceSource;
}

export type DealFields = Record<string, ProvenanceField>;

/** Provenance values that only the server may assign — never the client. */
const SERVER_ONLY_SOURCES = new Set<string>([
  "extracted_unconfirmed",
  "extracted_confirmed",
]);

// ─── Known extraction field names ─────────────────────────────────────────────
// Used to index the AI extraction output into deal fields.
// This list drives both the AI prompt schema (EXTRACTION_SCHEMA) and the
// ExtractionOutputSchema Zod validator — adding a field here automatically
// propagates to both.
const EXTRACTION_FIELD_NAMES = [
  "provider",
  "productName",
  "tariffName",
  "monthlyCostGbp",
  "annualCostGbp",
  "renewalDate",
  "contractEndDate",
  "setupFeeGbp",
  "exitFeeGbp",
  "noticeDays",
  "promotionEndDate",
  "priceIncreasePct",
  "paymentMethod",
  // Bundle fields — returned for broadband/mobile/multi-service documents
  "bundleProducts",
  "bundleDiscount",
  "inclusions",
  "exclusions",
  "notes",
  // Energy
  "unitRatePencePkwh",
  "standingChargePencePday",
  "gasUnitRatePencePkwh",
  "gasStandingChargePencePday",
  // Broadband
  "downloadSpeedMbps",
  "uploadSpeedMbps",
  "bundleTerms",
  // Insurance
  "annualPremiumGbp",
  "coverType",
  "excessGbp",
  "addOns",
  // Credit/loan
  "aprPct",
  "balanceGbp",
  "arrangementFeeGbp",
  "promoExpiryDate",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dealToApi(row: typeof currentDealsTable.$inferSelect) {
  return {
    serviceId: row.serviceId,
    fields: row.fields as DealFields,
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function extractionToApi(row: typeof documentExtractionsTable.$inferSelect) {
  return {
    extractionId: row.extractionId,
    serviceId: row.serviceId,
    status: row.status,
    fields: row.draftFields as DealFields,
    extractedAt: row.extractedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    aiDisclosure: AI_DISCLOSURE,
  };
}

// AI_DISCLOSURE is returned in every extraction response and shown in the UI.
// Accuracy is critical — users rely on this text to understand what was sent
// to OpenAI and what OpenAI may retain.
//
// Key facts:
//  - store:false disables Responses API application-state storage (the request
//    is NOT saved to your OpenAI account history or used for model training).
//  - OpenAI still processes the request and may retain API content temporarily
//    in abuse-monitoring logs under the data controls of the caller's account.
//  - Renewal Scout does not retain the raw document bytes after processing.
const AI_DISCLOSURE =
  "This document is sent to the OpenAI API for field extraction. " +
  "Renewal Scout does not retain the raw document after processing. " +
  "The API request uses store:false, which disables normal Responses application-state storage. " +
  "OpenAI may still retain API content temporarily in abuse-monitoring logs " +
  "under the data controls applicable to your OpenAI account. " +
  "Review every extracted value before confirming it.";

async function getOrCreateDeal(serviceId: number) {
  const [existing] = await db
    .select()
    .from(currentDealsTable)
    .where(eq(currentDealsTable.serviceId, serviceId));
  return existing ?? null;
}

// ─── GET /services/:id/current-deal ───────────────────────────────────────────

router.get("/services/:id/current-deal", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const deal = await getOrCreateDeal(id);
  if (!deal) {
    res.json({
      serviceId: id,
      fields: {},
      lastConfirmedAt: null,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  res.json(dealToApi(deal));
});

// ─── PUT /services/:id/current-deal ───────────────────────────────────────────
// Manual deal update. Only `values` and `clear` are accepted.
// Server ALWAYS assigns source: "user" — clients cannot submit provenance.

// .strict() rejects any key other than values/clear — clients cannot sneak in
// provenance fields (source) or other unexpected properties.
const UpdateDealBodySchema = z.object({
  /** Field name → raw value. Server assigns source:"user". */
  values: z.record(z.string(), z.unknown()).optional(),
  /** Keys whose user-entered values should be removed. */
  clear: z.array(z.string()).optional(),
}).strict();

router.put("/services/:id/current-deal", async (req, res): Promise<void> => {
  const id = parseRouteId(req.params["id"]);
  if (!id) {
    res.status(400).json({ error: "Invalid id: must be a positive integer." });
    return;
  }

  // Reject if client tries to set provenance directly (old API pattern)
  const rawBody = req.body as Record<string, unknown>;
  if ("fields" in rawBody && rawBody["fields"] !== undefined) {
    const rawFields = rawBody["fields"] as Record<string, unknown>;
    for (const [, pf] of Object.entries(rawFields)) {
      if (
        pf &&
        typeof pf === "object" &&
        "source" in pf &&
        SERVER_ONLY_SOURCES.has(String((pf as { source: unknown }).source))
      ) {
        res.status(400).json({
          error:
            'Provenance source "extracted_unconfirmed" and "extracted_confirmed" ' +
            "are assigned server-side and cannot be submitted by clients. " +
            "Use the extraction endpoint to create extracted fields.",
        });
        return;
      }
    }
  }

  const parsed = UpdateDealBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body: " + parsed.error.message });
    return;
  }

  const [service] = await db
    .select()
    .from(servicesTable)
    .where(eq(servicesTable.id, id));
  if (!service) {
    res.status(404).json({ error: "Service not found." });
    return;
  }

  const { values = {}, clear = [] } = parsed.data;

  // Validate submitted values against service-specific schema.
  // `validation.data` holds Zod-coerced values (e.g. "42.5" string → 42.5 number)
  // that MUST be persisted rather than the raw `values` input.
  let coercedValues: Record<string, unknown> = values;
  if (Object.keys(values).length > 0) {
    const validation = validateDealValues(service.serviceType, values);
    if (!validation.success) {
      res.status(400).json({ error: "Deal field validation failed: " + validation.error });
      return;
    }
    coercedValues = validation.data;
  }

  const existing = await getOrCreateDeal(id);
  const currentFields: DealFields = (existing?.fields as DealFields) ?? {};
  const updatedFields: DealFields = { ...currentFields };

  // Apply coerced values — server assigns source: "user".
  // Iterate over coercedValues (Zod-parsed output) rather than the raw input.
  // Zod strips unknown keys, so this loop naturally enforces the schema's
  // declared field list: arbitrary or unrecognised field names are never stored.
  for (const [key, coercedVal] of Object.entries(coercedValues)) {
    const rawVal = values[key];
    // Skip if the raw input was absent, null, or empty string
    if (rawVal === null || rawVal === undefined || String(rawVal).trim() === "") continue;
    // Store the Zod-coerced value (e.g. numeric string → number)
    if (coercedVal !== null && coercedVal !== undefined) {
      updatedFields[key] = { value: coercedVal, source: "user" };
    }
  }

  // Clear user-entered fields only (extracted_confirmed survives)
  for (const key of clear) {
    if (updatedFields[key]?.source === "user") {
      delete updatedFields[key];
    }
  }

  let row;
  if (existing) {
    [row] = await db
      .update(currentDealsTable)
      .set({ fields: updatedFields, updatedAt: new Date() })
      .where(eq(currentDealsTable.serviceId, id))
      .returning();
  } else {
    [row] = await db
      .insert(currentDealsTable)
      .values({ serviceId: id, fields: updatedFields })
      .returning();
  }
  res.json(dealToApi(row!));
});

// ─── POST /services/:id/extract-document ──────────────────────────────────────

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
});

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const EXTRACT_RATE_LIMIT = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many extraction requests. Please try again in an hour." },
  // Default keyGenerator (IP-based with IPv6 support) — no custom override needed
  // since the app sets `trust proxy: 1` which resolves `req.ip` correctly.
});

// Zod schema for AI extraction output — all fields nullable.
// Must be kept in sync with EXTRACTION_FIELD_NAMES above.
const ExtractionOutputSchema = z.object({
  provider: z.string().nullable(),
  productName: z.string().nullable(),
  tariffName: z.string().nullable(),
  monthlyCostGbp: z.number().nullable(),
  annualCostGbp: z.number().nullable(),
  renewalDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  setupFeeGbp: z.number().nullable(),
  exitFeeGbp: z.number().nullable(),
  noticeDays: z.number().nullable(),
  promotionEndDate: z.string().nullable(),
  priceIncreasePct: z.number().nullable(),
  paymentMethod: z.string().nullable(),
  // Bundle fields
  bundleProducts: z.string().nullable(),
  bundleDiscount: z.string().nullable(),
  inclusions: z.string().nullable(),
  exclusions: z.string().nullable(),
  notes: z.string().nullable(),
  // Energy
  unitRatePencePkwh: z.number().nullable(),
  standingChargePencePday: z.number().nullable(),
  gasUnitRatePencePkwh: z.number().nullable(),
  gasStandingChargePencePday: z.number().nullable(),
  // Broadband
  downloadSpeedMbps: z.number().nullable(),
  uploadSpeedMbps: z.number().nullable(),
  bundleTerms: z.string().nullable(),
  // Insurance
  annualPremiumGbp: z.number().nullable(),
  coverType: z.string().nullable(),
  excessGbp: z.number().nullable(),
  addOns: z.string().nullable(),
  // Credit/loan
  aprPct: z.number().nullable(),
  balanceGbp: z.number().nullable(),
  arrangementFeeGbp: z.number().nullable(),
  promoExpiryDate: z.string().nullable(),
});

// Fields that the AI should return as strings (dates, text, enumerations)
const EXTRACTION_STRING_FIELDS = new Set([
  "provider",
  "productName",
  "tariffName",
  "renewalDate",
  "contractEndDate",
  "promotionEndDate",
  "paymentMethod",
  "bundleProducts",
  "bundleDiscount",
  "inclusions",
  "exclusions",
  "notes",
  // Broadband
  "bundleTerms",
  // Insurance
  "coverType",
  "addOns",
  // Credit/loan
  "promoExpiryDate",
]);

// JSON Schema used for OpenAI structured output.
// Each field uses its actual type (string or number) rather than a union,
// so the model returns values that pass the ExtractionOutputSchema Zod check
// without a type-mismatch rejection.
const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: Object.fromEntries(
    EXTRACTION_FIELD_NAMES.map((k) => [
      k,
      EXTRACTION_STRING_FIELDS.has(k)
        ? { type: ["string", "null"] as unknown as string }
        : { type: ["number", "null"] as unknown as string },
    ]),
  ),
  required: EXTRACTION_FIELD_NAMES,
  additionalProperties: false,
};

// Maximum retry attempts for transient OpenAI errors
const MAX_EXTRACT_RETRIES = 2;
const OPENAI_TIMEOUT_MS = 45_000;

router.post(
  "/services/:id/extract-document",
  EXTRACT_RATE_LIMIT,
  (req, res, next) => {
    upload.single("document")(req, res, (err) => {
      if (
        err instanceof multer.MulterError &&
        err.code === "LIMIT_FILE_SIZE"
      ) {
        res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
        return;
      }
      if (err) { next(err); return; }
      next();
    });
  },
  async (req, res): Promise<void> => {
    // Cast needed: multi-handler route widens req.params to string | string[]
    const id = parseRouteId(req.params["id"] as string);
    if (!id) {
      res.status(400).json({ error: "Invalid id: must be a positive integer." });
      return;
    }

    const [service] = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.id, id));
    if (!service) {
      res.status(404).json({ error: "Service not found." });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No document uploaded." });
      return;
    }

    // Magic-byte detection — never trust the client-supplied Content-Type.
    // If the file type cannot be identified, reject it. No MIME fallback.
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MIME_TYPES.has(detected.mime)) {
      const rejected = detected?.mime ?? "unidentified file type";
      res.status(415).json({
        error: `Unsupported file type: ${rejected}. Only PDF, JPEG, and PNG are accepted.`,
      });
      // Clear buffer before returning
      file.buffer = Buffer.alloc(0);
      return;
    }
    const mime = detected.mime;

    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      file.buffer = Buffer.alloc(0);
      res.status(503).json({
        error: "AI extraction is not configured (OPENAI_API_KEY missing).",
      });
      return;
    }

    // Convert to Base64 — never log the buffer
    const base64 = file.buffer.toString("base64");

    // Build the document content item with a GENERIC filename so the original
    // filename (which may contain personal details) is never sent to OpenAI.
    const isPdf = mime === "application/pdf";
    const genericFilename = isPdf ? "document.pdf" : "document.img";
    const documentContent = isPdf
      ? ({
          type: "input_file",
          filename: genericFilename,
          file_data: `data:application/pdf;base64,${base64}`,
        } as unknown as OpenAI.Responses.ResponseInputContent)
      : ({
          type: "input_image",
          image_url: `data:${mime};base64,${base64}`,
        } as unknown as OpenAI.Responses.ResponseInputContent);

    // Clear the buffer from memory before making the API call
    file.buffer = Buffer.alloc(0);

    let extractedValues: z.infer<typeof ExtractionOutputSchema> | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_EXTRACT_RETRIES; attempt++) {
      try {
        const openai = new OpenAI({ apiKey });
        const model = process.env["OPENAI_MODEL"] ?? "gpt-4o-mini";
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

        try {
          const response = await openai.responses.create(
            {
              model,
              store: false, // Do NOT retain the document on OpenAI servers
              input: [
                {
                  role: "user",
                  content: [
                    documentContent,
                    {
                      type: "input_text",
                      text: `You are extracting current deal information from a UK household service document
(bill, renewal letter, tariff confirmation, or similar). Extract only information
you can see clearly. Set fields to null if not visible or unclear — do NOT guess.
Service type: ${service.serviceType}, Provider: ${service.provider}.
Return a JSON object matching the schema.`,
                    },
                  ],
                },
              ],
              text: {
                format: {
                  type: "json_schema",
                  name: "deal_extraction",
                  schema: EXTRACTION_SCHEMA,
                  strict: true,
                },
              },
            },
            { signal: controller.signal },
          );

          const outputText = response.output_text;
          if (!outputText) throw new Error("No output from AI extraction.");

          const parsedOutput = ExtractionOutputSchema.safeParse(
            JSON.parse(outputText),
          );
          if (!parsedOutput.success)
            throw new Error("AI extraction output failed schema validation.");

          extractedValues = parsedOutput.data;
          lastError = null;
          break; // success
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err) {
        lastError = err;
        const isRetryable =
          err instanceof Error &&
          (err.message.includes("timeout") ||
            err.message.includes("ECONNRESET") ||
            err.message.includes("rate_limit") ||
            err.name === "AbortError");
        if (!isRetryable || attempt === MAX_EXTRACT_RETRIES) break;
        // Brief back-off before retry
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }

    if (!extractedValues) {
      logger.error({ err: lastError, serviceId: id }, "Document extraction failed");
      res.status(500).json({ error: "AI extraction failed. Please try again." });
      return;
    }

    // Build draft fields — all marked extracted_unconfirmed
    const draftFields: DealFields = {};
    let fieldCount = 0;
    for (const key of EXTRACTION_FIELD_NAMES) {
      const value = (extractedValues as Record<string, unknown>)[key];
      if (value !== null && value !== undefined) {
        draftFields[key] = { value, source: "extracted_unconfirmed" };
        fieldCount++;
      }
    }

    const extractionId = randomUUID();
    const draftFieldKeys = Object.keys(draftFields);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h TTL

    // Persist extraction draft with full field values for resume capability
    await db.insert(documentExtractionsTable).values({
      serviceId: id,
      extractionId,
      fieldCount,
      confirmedCount: 0,
      draftFieldKeys,
      draftFields,
      status: "draft",
      expiresAt,
    });

    res.json({
      extractionId,
      serviceId: id,
      status: "draft",
      fields: draftFields,
      extractedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      aiDisclosure: AI_DISCLOSURE,
    });
  },
);

// ─── Validation error class for use inside db.transaction() ───────────────────
// Throwing this inside a transaction callback causes the transaction to roll
// back entirely (leaving the draft in its original state), rather than
// committing a "failed" status that would prevent the user from retrying.
class ConfirmationValidationError extends Error {
  constructor(public readonly clientError: string) {
    super(clientError);
    this.name = "ConfirmationValidationError";
  }
}

// ─── GET /services/:id/extraction-draft/pending ────────────────────────────────
// Returns the most recent pending (status=draft) extraction draft, or null.
// Used to restore UI state after page refresh.

router.get(
  "/services/:id/extraction-draft/pending",
  async (req, res): Promise<void> => {
    const id = parseRouteId(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id: must be a positive integer." });
      return;
    }

    const [service] = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.id, id));
    if (!service) {
      res.status(404).json({ error: "Service not found." });
      return;
    }

    // Find the most recent draft-status extraction for this service.
    // ORDER BY extractedAt DESC so the newest draft is returned when multiple exist.
    const [pending] = await db
      .select()
      .from(documentExtractionsTable)
      .where(
        and(
          eq(documentExtractionsTable.serviceId, id),
          eq(documentExtractionsTable.status, "draft"),
        ),
      )
      .orderBy(desc(documentExtractionsTable.extractedAt));

    if (!pending) {
      res.json(null);
      return;
    }

    // Check expiry.  The update is conditional on status='draft' so it cannot
    // overwrite a terminal state (applied/discarded) if a confirm raced between
    // the SELECT above and this UPDATE.
    if (pending.expiresAt && pending.expiresAt < new Date()) {
      await db
        .update(documentExtractionsTable)
        .set({ status: "expired" })
        .where(
          and(
            eq(documentExtractionsTable.extractionId, pending.extractionId),
            eq(documentExtractionsTable.status, "draft"),
          ),
        );
      res.json(null);
      return;
    }

    res.json(extractionToApi(pending));
  },
);

// ─── POST /services/:id/extraction-draft/:extractionId/discard ─────────────────

router.post(
  "/services/:id/extraction-draft/:extractionId/discard",
  async (req, res): Promise<void> => {
    const id = parseRouteId(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id: must be a positive integer." });
      return;
    }

    const extractionId = req.params["extractionId"];

    const [service] = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.id, id));
    if (!service) {
      res.status(404).json({ error: "Service not found." });
      return;
    }

    const [extraction] = await db
      .select()
      .from(documentExtractionsTable)
      .where(eq(documentExtractionsTable.extractionId, extractionId));

    if (!extraction || extraction.serviceId !== id) {
      res.status(404).json({ error: "Extraction draft not found." });
      return;
    }

    // Only draft-status extractions can be discarded.
    // 'applying' is excluded deliberately: a confirm operation has already claimed
    // that state and will write 'applied' — allowing discard on 'applying' would
    // create a race where the confirmed values land in current_deals after the user
    // chose to discard, violating the atomic lifecycle guarantee.
    if (extraction.status !== "draft") {
      res.status(409).json({
        error: `Draft cannot be discarded — current status is "${extraction.status}". ` +
          (extraction.status === "applying"
            ? "A confirmation is in progress; wait for it to complete."
            : ""),
      });
      return;
    }

    // Atomic conditional update: only transitions draft→discarded.
    // WHERE includes expiry guard so a past-deadline draft cannot be discarded
    // (it should be expired, not discarded — and confirms also reject it).
    // Using .returning() lets us detect races: a concurrent confirm that claimed
    // draft→applying between our read and this write returns 0 rows.
    const now = new Date();
    const [discardedRow] = await db
      .update(documentExtractionsTable)
      .set({ status: "discarded", deletedAt: now })
      .where(
        and(
          eq(documentExtractionsTable.extractionId, extractionId),
          eq(documentExtractionsTable.status, "draft"),
          or(
            isNull(documentExtractionsTable.expiresAt),
            gt(documentExtractionsTable.expiresAt, now),
          ),
        ),
      )
      .returning({ id: documentExtractionsTable.id });

    if (!discardedRow) {
      // Zero rows: a concurrent confirm claimed the draft between our read and this
      // update — the draft is no longer in 'draft' state.
      res.status(409).json({
        error:
          "Draft cannot be discarded — it has been claimed by a concurrent operation. " +
          "Wait for it to complete or check the current deal for confirmed values.",
      });
      return;
    }

    res.status(204).send();
  },
);

// Zod schema for the full confirm request body — validated before any DB operation.
// .strict() prevents malformed entries from slipping through the transaction
// (which would mark the draft 'failed' rather than leaving it retryable).
// `source` is permitted inside confirmedFields so the subsequent provenance-guard
// check can inspect it; the server always overwrites the source when persisting.
// .strict() on the outer object rejects top-level keys other than the two declared.
const ConfirmBodySchema = z
  .object({
    confirmedFields: z
      .record(z.string(), z.object({ value: z.unknown(), source: z.string().optional() }))
      .optional()
      .default({}),
    deletedFields: z.array(z.string()).optional().default([]),
  })
  .strict();

// ─── PUT /services/:id/extraction-draft/:extractionId/confirm ─────────────────
// ATOMIC: uses a DB transaction with conditional status change draft→applying.
// Two concurrent confirmations yield exactly one success and one 409.

router.put(
  "/services/:id/extraction-draft/:extractionId/confirm",
  async (req, res): Promise<void> => {
    const id = parseRouteId(req.params["id"]);
    if (!id) {
      res.status(400).json({ error: "Invalid id: must be a positive integer." });
      return;
    }

    const extractionId = req.params["extractionId"];

    // ── Step A: Full body validation BEFORE any DB call ─────────────────────────
    // A malformed body must return 400 without touching the draft lifecycle.
    const parsedBody = ConfirmBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({
        error: "Invalid request body: " + parsedBody.error.message,
      });
      return;
    }
    const { confirmedFields, deletedFields } = parsedBody.data;

    // Reject any submitted provenance (server assigns it — never the client)
    for (const [, pf] of Object.entries(confirmedFields)) {
      if (pf && typeof pf === "object" && "source" in pf) {
        const src = (pf as { source: unknown }).source;
        if (SERVER_ONLY_SOURCES.has(String(src))) {
          res.status(400).json({
            error:
              "Provenance source in confirmedFields is controlled server-side. " +
              "Submit only the field value (not source) in confirmedFields.",
          });
          return;
        }
      }
    }

    // ── Step B: Fetch service for schema-based coercion ──────────────────────────
    // serviceType is immutable, so fetching outside the transaction is safe.
    // This also means a 404 on missing service returns cleanly without claiming.
    const [service] = await db
      .select()
      .from(servicesTable)
      .where(eq(servicesTable.id, id));
    if (!service) {
      res.status(404).json({ error: "Service not found." });
      return;
    }

    // ── Step C: Coerce and validate the submitted confirmed values ───────────────
    // Applies the same service-specific Zod schema as the manual PUT:
    //  - numeric strings ("45.99") are coerced to numbers
    //  - invalid values (e.g. NaN, out-of-range) are rejected with 400
    //  - the resulting coercedConfirmedValues are what get persisted
    const rawConfirmedValues: Record<string, unknown> = {};
    for (const [k, pf] of Object.entries(confirmedFields)) {
      rawConfirmedValues[k] = pf.value;
    }

    let coercedConfirmedValues: Record<string, unknown> = rawConfirmedValues;
    if (Object.keys(rawConfirmedValues).length > 0) {
      const validation = validateDealValues(service.serviceType, rawConfirmedValues);
      if (!validation.success) {
        res.status(400).json({
          error: "Confirmed field validation failed: " + validation.error,
        });
        return;
      }
      coercedConfirmedValues = validation.data;
    }

    // Atomically claim and apply
    try {
      const result = await db.transaction(async (tx) => {
        // Step 1: Fetch the extraction
        const [extraction] = await tx
          .select()
          .from(documentExtractionsTable)
          .where(eq(documentExtractionsTable.extractionId, extractionId));

        if (!extraction || extraction.serviceId !== id) {
          return { status: 404, body: { error: "Extraction not found." } };
        }

        // Step 2: Conditional status change draft→applying (atomic concurrency guard).
        // Also enforces expiry: an expired draft cannot be confirmed — the WHERE
        // clause requires expiresAt IS NULL OR expiresAt > now().
        const now = new Date();
        const claimed = await tx
          .update(documentExtractionsTable)
          .set({ status: "applying" })
          .where(
            and(
              eq(documentExtractionsTable.extractionId, extractionId),
              eq(documentExtractionsTable.status, "draft"),
              or(
                isNull(documentExtractionsTable.expiresAt),
                gt(documentExtractionsTable.expiresAt, now),
              ),
            ),
          )
          .returning({ id: documentExtractionsTable.id });

        if (claimed.length === 0) {
          // Zero rows: draft is no longer in the claimable 'draft' state, or it
          // has expired.  Return 409 so the caller knows it cannot proceed.
          return {
            status: 409,
            body: {
              error:
                "This extraction draft has already been applied, discarded, expired, or is being applied concurrently.",
            },
          };
        }

        // Step 3: Validate confirmed/deleted field keys.
        // We THROW rather than return so that the transaction rolls back entirely,
        // leaving the draft in its pre-claim 'draft' state.  The user can then
        // correct the request and resubmit without hitting the 409 claim guard.
        const allowedKeys = new Set<string>(extraction.draftFieldKeys as string[]);
        const illegalConfirm = Object.keys(confirmedFields).filter(
          (k) => !allowedKeys.has(k),
        );
        if (illegalConfirm.length > 0) {
          throw new ConfirmationValidationError(
            `confirmedFields contains keys not in this extraction draft: ${illegalConfirm.join(", ")}`,
          );
        }
        const illegalDelete = deletedFields.filter((k) => !allowedKeys.has(k));
        if (illegalDelete.length > 0) {
          throw new ConfirmationValidationError(
            `deletedFields contains keys not in this extraction draft: ${illegalDelete.join(", ")}`,
          );
        }

        // Step 4: Merge into current deal using COERCED values
        const [existing] = await tx
          .select()
          .from(currentDealsTable)
          .where(eq(currentDealsTable.serviceId, id));

        const currentFields: DealFields = (existing?.fields as DealFields) ?? {};
        const updatedFields: DealFields = { ...currentFields };
        let confirmedCount = 0;

        for (const [key] of Object.entries(confirmedFields)) {
          // Only persist fields that the service-specific Zod schema knows about.
          // Zod strips unknown keys from coercedConfirmedValues, so any key absent
          // from that map is not valid for this service type — it is silently dropped.
          // This prevents cross-service-category fields (e.g. energy unit rates on a
          // broadband service) from being written, even if they were in the draft.
          if (!(key in coercedConfirmedValues)) continue;
          updatedFields[key] = {
            value: coercedConfirmedValues[key] ?? null,
            source: "extracted_confirmed",
          };
          confirmedCount++;
        }
        // Deleted draft fields: discarded from draft; do NOT remove pre-existing values

        let dealRow;
        if (existing) {
          [dealRow] = await tx
            .update(currentDealsTable)
            .set({
              fields: updatedFields,
              lastConfirmedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(currentDealsTable.serviceId, id))
            .returning();
        } else {
          [dealRow] = await tx
            .insert(currentDealsTable)
            .values({
              serviceId: id,
              fields: updatedFields,
              lastConfirmedAt: new Date(),
            })
            .returning();
        }

        // Step 5: Mark extraction as applied
        await tx
          .update(documentExtractionsTable)
          .set({ status: "applied", confirmedCount, deletedAt: new Date() })
          .where(eq(documentExtractionsTable.extractionId, extractionId));

        return { status: 200, body: dealToApi(dealRow!) };
      });

      res.status(result.status).json(result.body);
    } catch (err) {
      if (err instanceof ConfirmationValidationError) {
        // Transaction rolled back — draft is still in 'draft' state, user can retry
        res.status(400).json({ error: err.clientError });
        return;
      }
      logger.error({ err, extractionId }, "Extraction confirmation failed");
      // Unexpected server error: attempt to mark the extraction as failed (best-effort)
      // so it doesn't linger in 'applying' state indefinitely.
      await db
        .update(documentExtractionsTable)
        .set({ status: "failed" })
        .where(
          and(
            eq(documentExtractionsTable.extractionId, extractionId),
            eq(documentExtractionsTable.status, "applying"),
          ),
        )
        .catch(() => undefined);
      res.status(500).json({ error: "Confirmation failed. Please try again." });
    }
  },
);

export default router;
