/**
 * Exported separately so the Zod schema can be imported in tests
 * without pulling in the full OpenAI + DB dependencies.
 */
import { z } from "zod";

export const DealOptionSchema = z.object({
  provider: z.string().max(200),
  product_name: z.string().max(200),
  price_status: z.enum([
    "confirmed_public",
    "indicative",
    "personal_quote_required",
    "unavailable",
  ]),
  /** Non-negative finite cost, or null when not publicly available. */
  annual_cost_gbp: z.number().finite().nonnegative().nullable(),
  /** Non-negative finite monthly cost, or null when not publicly available. */
  monthly_cost_gbp: z.number().finite().nonnegative().nullable(),
  contract_length_months: z.number().int().nonnegative().nullable(),
  headline_terms: z.array(z.string().max(500)).max(10),
  important_exclusions: z.array(z.string().max(500)).max(10),
  source_urls: z.array(z.string()).max(20),
});

export const DealReportSchema = z.object({
  service_type: z.string().max(100),
  /** YYYY-MM-DD date string. */
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "as_of_date must be YYYY-MM-DD"),
  scope_statement: z.string().max(1000),
  current_deal_assessment: z.string().max(2000),
  /** At most three options; the report must not exceed this. */
  options: z.array(DealOptionSchema).max(3),
  recommended_next_step: z.string().max(2000),
  /**
   * Server overrides this with a calculated value — AI output is discarded.
   * Null when savings cannot be computed (personalised quote required, or no
   * confirmed current cost available for comparison).
   */
  estimated_annual_saving_gbp: z.number().finite().nonnegative().nullable(),
  missing_information: z.array(z.string().max(500)).max(20),
  comparison_checklist: z.array(z.string().max(500)).max(20),
  application_pack: z.array(z.string().max(500)).max(20),
  warnings: z.array(z.string().max(1000)).max(10),
  sources: z.array(z.string()).max(30),
  comparison_based_on: z.array(z.string().max(500)).max(20),
});

export type DealOption = z.infer<typeof DealOptionSchema>;
export type DealReport = z.infer<typeof DealReportSchema>;
