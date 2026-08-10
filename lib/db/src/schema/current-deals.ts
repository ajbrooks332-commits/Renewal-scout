import {
  pgTable,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { servicesTable } from "./services";

/**
 * Stores the user's current deal for a service, with provenance on each field.
 *
 * `fields` is a JSONB object where each key is a deal field name and each value
 * is a ProvenanceField:
 *   { value: <any | null>, source: 'user' | 'extracted_confirmed' | 'extracted_unconfirmed' | 'unknown' }
 *
 * Only fields with source 'user' or 'extracted_confirmed' are included in
 * research prompts. 'extracted_unconfirmed' values are never used for research.
 *
 * Known field names (by convention, not enforced at DB level):
 *   provider, tariffName, monthlyCostGbp, annualCostGbp, renewalDate,
 *   contractEndDate, exitFeGbp, noticeDays, inclusions, exclusions, notes
 */
export const currentDealsTable = pgTable("current_deals", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id")
    .notNull()
    .unique()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  /**
   * Record<string, { value: unknown | null, source: ProvenanceSource }>
   * ProvenanceSource = 'user' | 'extracted_confirmed' | 'extracted_unconfirmed' | 'unknown'
   */
  fields: jsonb("fields").notNull().default({}),
  lastConfirmedAt: timestamp("last_confirmed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CurrentDeal = typeof currentDealsTable.$inferSelect;
