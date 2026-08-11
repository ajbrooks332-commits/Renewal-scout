import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  servicesTable,
  currentDealsTable,
  documentExtractionsTable,
} from "@workspace/db";
import { parseRouteId } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/require-auth";
import { randomUUID } from "crypto";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import OpenAI from "openai";
import { z } from "zod";
import { logger } from "../lib/logger";

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

// ─── Known deal field names (by convention) ────────────────────────────────────

const DEAL_FIELD_NAMES = [
  "provider",
  "tariffName",
  "monthlyCostGbp",
  "annualCostGbp",
  "renewalDate",
  "contractEndDate",
  "exitFeeGbp",
  "noticeDays",
  "inclusions",
  "exclusions",
  "notes",
];

// ─── Validation ───────────────────────────────────────────────────────────────

const ProvenanceFieldSchema = z.object({
  value: z.unknown().nullable().optional(),
  source: z.enum([
    "user",
    "extracted_confirmed",
    "extracted_unconfirmed",
    "unknown",
  ]),
});

const DealFieldsSchema = z.record(z.string(), ProvenanceFieldSchema);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dealToApi(row: typeof currentDealsTable.$inferSelect) {
  return {
    serviceId: row.serviceId,
    fields: row.fields as DealFields,
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

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

router.put("/services/:id/current-deal", async (req, res): Promise<void> => {
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

  const parsed = DealFieldsSchema.safeParse(
    (req.body as { fields?: unknown })?.fields,
  );
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid fields: " + parsed.error.message,
    });
    return;
  }

  const fields = parsed.data as DealFields;

  const existing = await getOrCreateDeal(id);
  let row;
  if (existing) {
    [row] = await db
      .update(currentDealsTable)
      .set({ fields, updatedAt: new Date() })
      .where(eq(currentDealsTable.serviceId, id))
      .returning();
  } else {
    [row] = await db
      .insert(currentDealsTable)
      .values({ serviceId: id, fields })
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

// Zod schema for AI extraction output
const ExtractionOutputSchema = z.object({
  provider: z.string().nullable(),
  tariffName: z.string().nullable(),
  monthlyCostGbp: z.number().nullable(),
  annualCostGbp: z.number().nullable(),
  renewalDate: z.string().nullable(),
  contractEndDate: z.string().nullable(),
  exitFeeGbp: z.number().nullable(),
  noticeDays: z.number().nullable(),
  inclusions: z.string().nullable(),
  exclusions: z.string().nullable(),
  notes: z.string().nullable(),
});

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    provider: { type: ["string", "null"] },
    tariffName: { type: ["string", "null"] },
    monthlyCostGbp: { type: ["number", "null"] },
    annualCostGbp: { type: ["number", "null"] },
    renewalDate: { type: ["string", "null"] },
    contractEndDate: { type: ["string", "null"] },
    exitFeeGbp: { type: ["number", "null"] },
    noticeDays: { type: ["number", "null"] },
    inclusions: { type: ["string", "null"] },
    exclusions: { type: ["string", "null"] },
    notes: { type: ["string", "null"] },
  },
  required: [
    "provider",
    "tariffName",
    "monthlyCostGbp",
    "annualCostGbp",
    "renewalDate",
    "contractEndDate",
    "exitFeeGbp",
    "noticeDays",
    "inclusions",
    "exclusions",
    "notes",
  ],
  additionalProperties: false,
};

router.post(
  "/services/:id/extract-document",
  (req, res, next) => {
    upload.single("document")(req, res, (err) => {
      if (
        err instanceof multer.MulterError &&
        err.code === "LIMIT_FILE_SIZE"
      ) {
        res
          .status(413)
          .json({ error: "File too large. Maximum size is 10 MB." });
        return;
      }
      if (err) {
        next(err);
        return;
      }
      next();
    });
  },
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

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No document uploaded." });
      return;
    }

    // Validate MIME type from actual file bytes (not the client-supplied header)
    const detected = await fileTypeFromBuffer(file.buffer);
    const mime = detected?.mime ?? file.mimetype;
    if (!ALLOWED_MIME_TYPES.has(mime)) {
      res.status(415).json({
        error: `Unsupported file type: ${mime}. Only PDF, JPEG, and PNG are accepted.`,
      });
      return;
    }

    const apiKey = process.env["OPENAI_API_KEY"];
    if (!apiKey) {
      res.status(503).json({
        error: "AI extraction is not configured (OPENAI_API_KEY missing).",
      });
      return;
    }

    // Convert to Base64 — never log the buffer
    const base64 = file.buffer.toString("base64");

    // Build the document content item:
    // PDFs must use input_file / file_data; images use input_image / image_url.
    const isPdf = mime === "application/pdf";
    const documentContent = isPdf
      ? ({
          type: "input_file",
          filename: file.originalname || "document.pdf",
          file_data: `data:application/pdf;base64,${base64}`,
        } as unknown as OpenAI.Responses.ResponseInputContent)
      : ({
          type: "input_image",
          image_url: `data:${mime};base64,${base64}`,
        } as unknown as OpenAI.Responses.ResponseInputContent);

    // Clear the buffer from memory before making the API call
    file.buffer = Buffer.alloc(0);

    let extractedValues: z.infer<typeof ExtractionOutputSchema> | null = null;
    try {
      const openai = new OpenAI({ apiKey });
      const model = process.env["OPENAI_MODEL"] ?? "gpt-4o";

      const response = await openai.responses.create({
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
      });

      const outputText = response.output_text;
      if (!outputText) throw new Error("No output from AI extraction.");

      const parsedOutput = ExtractionOutputSchema.safeParse(
        JSON.parse(outputText),
      );
      if (!parsedOutput.success)
        throw new Error("AI extraction output failed schema validation.");
      extractedValues = parsedOutput.data;
    } catch (err) {
      logger.error({ err, serviceId: id }, "Document extraction failed");
      res.status(500).json({ error: "AI extraction failed. Please try again." });
      return;
    }

    // Build draft fields — all marked extracted_unconfirmed
    const fields: DealFields = {};
    let fieldCount = 0;
    for (const key of DEAL_FIELD_NAMES) {
      const value = (extractedValues as Record<string, unknown>)[key];
      if (value !== null && value !== undefined) {
        fields[key] = { value, source: "extracted_unconfirmed" };
        fieldCount++;
      }
    }

    // Save metadata log (no document bytes — only extracted field names)
    const extractionId = randomUUID();
    const draftFieldKeys = Object.keys(fields);
    await db.insert(documentExtractionsTable).values({
      serviceId: id,
      extractionId,
      fieldCount,
      confirmedCount: 0,
      draftFieldKeys,
    });

    const extractedAt = new Date().toISOString();
    res.json({
      extractionId,
      serviceId: id,
      fields,
      extractedAt,
      aiDisclosure:
        "This document was sent to the OpenAI API for field extraction. " +
        "Document bytes are not stored by Renewal Scout. " +
        "Please review all extracted values before confirming.",
    });
  },
);

// ─── PUT /services/:id/extraction-draft/:extractionId/confirm ─────────────────

router.put(
  "/services/:id/extraction-draft/:extractionId/confirm",
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
      res.status(404).json({ error: "Extraction not found." });
      return;
    }
    // Prevent replay: once all draft fields have been resolved (confirmed or
    // deleted) the extraction is marked consumed. Re-confirming it would let an
    // old AI-derived value silently overwrite newer user-entered deal data.
    if (extraction.deletedAt) {
      res.status(409).json({
        error:
          "This extraction draft has already been applied and cannot be reused.",
      });
      return;
    }

    const body = req.body as {
      confirmedFields?: Record<
        string,
        { value: unknown; source: ProvenanceSource }
      >;
      deletedFields?: string[];
    };

    const confirmedFields = body.confirmedFields ?? {};
    const deletedFields = body.deletedFields ?? [];

    // Validate: all confirmed fields must have a valid source
    const parsedConfirmed = DealFieldsSchema.safeParse(confirmedFields);
    if (!parsedConfirmed.success) {
      res.status(400).json({
        error: "Invalid confirmedFields: " + parsedConfirmed.error.message,
      });
      return;
    }

    // Validate: only keys from the extraction draft may be confirmed or deleted.
    // This prevents overwriting or deleting arbitrary existing current-deal fields.
    const allowedKeys = new Set<string>(extraction.draftFieldKeys as string[]);
    const illegalConfirm = Object.keys(parsedConfirmed.data).filter(
      (k) => !allowedKeys.has(k),
    );
    if (illegalConfirm.length > 0) {
      res.status(400).json({
        error: `confirmedFields contains keys not in this extraction draft: ${illegalConfirm.join(", ")}`,
      });
      return;
    }
    const illegalDelete = deletedFields.filter((k) => !allowedKeys.has(k));
    if (illegalDelete.length > 0) {
      res.status(400).json({
        error: `deletedFields contains keys not in this extraction draft: ${illegalDelete.join(", ")}`,
      });
      return;
    }

    // Merge into existing current deal
    const existing = await getOrCreateDeal(id);
    const currentFields: DealFields = (existing?.fields as DealFields) ?? {};

    // Apply confirmed fields — the user has explicitly reviewed and approved each
    // value, so we write it with source: extracted_confirmed.
    const updatedFields: DealFields = { ...currentFields };
    let confirmedCount = 0;
    for (const [key, pf] of Object.entries(parsedConfirmed.data)) {
      updatedFields[key] = {
        value: pf.value ?? null,
        source: "extracted_confirmed",
      };
      confirmedCount++;
    }

    // Deleted draft fields are simply discarded — we do NOT remove pre-existing
    // current-deal values for those keys.

    let row;
    if (existing) {
      [row] = await db
        .update(currentDealsTable)
        .set({
          fields: updatedFields,
          lastConfirmedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(currentDealsTable.serviceId, id))
        .returning();
    } else {
      [row] = await db
        .insert(currentDealsTable)
        .values({
          serviceId: id,
          fields: updatedFields,
          lastConfirmedAt: new Date(),
        })
        .returning();
    }

    // Mark extraction consumed — prevents replay.
    await db
      .update(documentExtractionsTable)
      .set({ confirmedCount, deletedAt: new Date() })
      .where(eq(documentExtractionsTable.extractionId, extractionId));

    res.json(dealToApi(row!));
  },
);

export default router;
