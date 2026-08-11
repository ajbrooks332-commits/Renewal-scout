import {
  pgTable,
  serial,
  text,
  date,
  timestamp,
  boolean,
  integer,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const servicesTable = pgTable(
  "services",
  {
    id: serial("id").primaryKey(),
    serviceType: text("service_type").notNull().default("Other"),
    provider: text("provider").notNull(),
    productName: text("product_name"),
    /**
     * Monthly cost stored as integer pence (e.g. £45.99 → 4599).
     * Convert GBP decimal → pence at the API boundary before writing;
     * divide by 100 when returning to the API consumer.
     */
    monthlyCostPence: integer("monthly_cost_pence"),
    /**
     * Annual cost stored as integer pence (e.g. £540.00 → 54000).
     */
    annualCostPence: integer("annual_cost_pence"),
    renewalDate: date("renewal_date", { mode: "string" }),
    contractEndDate: date("contract_end_date", { mode: "string" }),
    noticeDays: integer("notice_days").notNull().default(30),
    researchWindowDays: integer("research_window_days").notNull().default(60),
    location: text("location"),
    currentTerms: text("current_terms"),
    preferences: text("preferences"),
    quoteFacts: text("quote_facts"),
    autoResearch: boolean("auto_research").notNull().default(true),
    active: boolean("active").notNull().default(true),
    lastResearchedAt: timestamp("last_researched_at", { withTimezone: true }),
    nextResearchAt: date("next_research_at", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      "services_notice_days_nonneg",
      sql`${table.noticeDays} >= 0`,
    ),
    check(
      "services_research_window_nonneg",
      sql`${table.researchWindowDays} >= 0`,
    ),
    check(
      "services_monthly_cost_nonneg",
      sql`${table.monthlyCostPence} IS NULL OR ${table.monthlyCostPence} >= 0`,
    ),
    check(
      "services_annual_cost_nonneg",
      sql`${table.annualCostPence} IS NULL OR ${table.annualCostPence} >= 0`,
    ),
  ],
);

export const insertServiceSchema = createInsertSchema(servicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof servicesTable.$inferSelect;
