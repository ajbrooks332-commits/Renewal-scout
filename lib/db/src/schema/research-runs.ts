import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { servicesTable } from "./services";

export const researchRunsTable = pgTable("research_runs", {
  id: serial("id").primaryKey(),
  serviceId: integer("service_id")
    .notNull()
    .references(() => servicesTable.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull().default("manual"),
  status: text("status").notNull().default("queued"),
  reportJson: text("report_json"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertResearchRunSchema = createInsertSchema(
  researchRunsTable
).omit({
  id: true,
  createdAt: true,
});
export type InsertResearchRun = z.infer<typeof insertResearchRunSchema>;
export type ResearchRun = typeof researchRunsTable.$inferSelect;
