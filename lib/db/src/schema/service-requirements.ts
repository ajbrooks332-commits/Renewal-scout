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
 * Service-specific requirement fields (e.g. broadband speed, cover type).
 * One row per service. `fields` is a JSONB record of requirement answers;
 * the valid keys are governed by `schemaVersion` and the service type.
 *
 * Answer-state semantics within `fields`:
 *   - Key absent from `fields`          → unanswered (never explicitly set)
 *   - Key present with `null` value     → explicitly "I don't know"
 *   - Key present with non-null value   → answered
 *
 * `unknownFields` additionally tracks which fields the user explicitly
 * marked as unknown via the UI. This mirrors the household_profile pattern
 * and allows future UI to restore the "I don't know" toggle state.
 */
export const serviceRequirementsTable = pgTable("service_requirements", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id")
    .notNull()
    .unique()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  schemaVersion: text("schema_version").notNull().default("1"),
  /**
   * Record<string, unknown | null> — null means "I don't know".
   * Keys and values are validated against the server's strict schema for the
   * service type; invalid or unknown keys are rejected at the API boundary.
   */
  fields: jsonb("fields").notNull().default({}),
  /**
   * Array of field keys the user explicitly marked as "I don't know" in the
   * UI. Subset of the keys in `fields` where value is null. Used for UI
   * state recovery (distinguishing toggled-unknown from simply unfilled).
   */
  unknownFields: jsonb("unknown_fields").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ServiceRequirements = typeof serviceRequirementsTable.$inferSelect;
