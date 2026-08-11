import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { servicesTable } from "./services";

/**
 * Metadata audit log for document extraction runs.
 * Document bytes and content are NEVER stored here — only metadata
 * and the list of field names/values the AI extracted (no raw document text).
 * The actual extracted field values are written to `current_deals.fields`
 * after user confirmation.
 *
 * Status lifecycle:
 *   draft     → Extraction done, awaiting user review
 *   applying  → Confirmation transaction in progress (concurrency lock)
 *   applied   → Confirmation completed successfully
 *   discarded → User discarded without confirming
 *   expired   → Draft TTL elapsed without action
 *   failed    → Extraction or confirmation failed unrecoverably
 */
export const documentExtractionsTable = pgTable(
  "document_extractions",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => servicesTable.id, { onDelete: "cascade" }),
    /** Stable identifier returned to the client for the confirmation step */
    extractionId: text("extraction_id").notNull().unique(),
    /** Number of fields the AI extracted */
    fieldCount: integer("field_count").notNull().default(0),
    /** Number of fields the user has confirmed */
    confirmedCount: integer("confirmed_count").notNull().default(0),
    /**
     * The field keys (names) that were part of this extraction draft.
     * Used to validate the confirmation step — only these keys may be
     * confirmed or deleted via the confirmation endpoint.
     */
    draftFieldKeys: jsonb("draft_field_keys")
      .$type<string[]>()
      .notNull()
      .default([]),
    /**
     * Snapshot of the extracted field values as ProvenanceField objects
     * (source: "extracted_unconfirmed"). Stored so the user can resume
     * a pending draft after a page refresh without re-uploading.
     */
    draftFields: jsonb("draft_fields")
      .$type<Record<string, { value: unknown; source: string }>>()
      .notNull()
      .default({}),
    /**
     * Lifecycle status for this extraction draft.
     * Enforced by the status_check constraint.
     */
    status: text("status").notNull().default("draft"),
    /**
     * When the draft expires (default 24h after creation).
     * A background scanner may mark draft rows as expired past this time.
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    extractedAt: timestamp("extracted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Set when the user discards the draft without confirming (legacy column; status is canonical) */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "document_extractions_status_check",
      sql`${table.status} IN ('draft', 'applying', 'applied', 'discarded', 'expired', 'failed')`,
    ),
  ],
);

export type DocumentExtraction = typeof documentExtractionsTable.$inferSelect;
