import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { servicesTable } from "./services";

export const researchRunsTable = pgTable(
  "research_runs",
  {
    id: serial("id").primaryKey(),
    serviceId: integer("service_id")
      .notNull()
      .references(() => servicesTable.id, { onDelete: "cascade" }),
    trigger: text("trigger").notNull().default("manual"),
    /**
     * When true, the research was triggered in generic mode — the AI prompt
     * omits personal household context and returns public-example results with
     * a disclaimer. Set when researchMode:"generic" is passed on the API request.
     */
    genericMode: boolean("generic_mode").notNull().default(false),
    /**
     * Valid values: queued | running | complete | failed
     * Enforced by the status_check constraint below.
     *
     * A partial UNIQUE index (research_runs_active_service_idx) enforces
     * at most one queued or running run per service at the DB level.
     */
    status: text("status").notNull().default("queued"),
    reportJson: text("report_json"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "research_runs_status_check",
      sql`${table.status} IN ('queued', 'running', 'complete', 'failed')`,
    ),
  ],
);

export const insertResearchRunSchema = createInsertSchema(
  researchRunsTable
).omit({
  id: true,
  createdAt: true,
});
export type InsertResearchRun = z.infer<typeof insertResearchRunSchema>;
export type ResearchRun = typeof researchRunsTable.$inferSelect;
