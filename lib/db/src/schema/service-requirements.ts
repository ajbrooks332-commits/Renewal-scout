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
 * Field values may be null (unknown). The schema version allows future
 * migrations to detect stale answers when the question set changes.
 */
export const serviceRequirementsTable = pgTable("service_requirements", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id")
    .notNull()
    .unique()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  schemaVersion: text("schema_version").notNull().default("1"),
  /** Record<string, unknown | null> — null means "I don't know" */
  fields: jsonb("fields").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ServiceRequirements = typeof serviceRequirementsTable.$inferSelect;
