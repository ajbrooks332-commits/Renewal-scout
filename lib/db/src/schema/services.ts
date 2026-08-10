import {
  pgTable,
  serial,
  text,
  real,
  date,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const servicesTable = pgTable("services", {
  id: serial("id").primaryKey(),
  serviceType: text("service_type").notNull().default("Other"),
  provider: text("provider").notNull(),
  productName: text("product_name"),
  monthlyCostGbp: real("monthly_cost_gbp"),
  annualCostGbp: real("annual_cost_gbp"),
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
});

export const insertServiceSchema = createInsertSchema(servicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof servicesTable.$inferSelect;
