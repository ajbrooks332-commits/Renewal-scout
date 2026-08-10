import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { servicesTable } from "./services";

/**
 * Metadata audit log for document extraction runs.
 * Document bytes and content are NEVER stored here — only metadata
 * and the list of field names/values the AI extracted (no raw document text).
 * The actual extracted field values are written to `current_deals.fields`
 * after user confirmation.
 */
export const documentExtractionsTable = pgTable("document_extractions", {
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
  draftFieldKeys: jsonb("draft_field_keys").$type<string[]>().notNull().default([]),
  extractedAt: timestamp("extracted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Set when the user discards the draft without confirming */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type DocumentExtraction = typeof documentExtractionsTable.$inferSelect;
