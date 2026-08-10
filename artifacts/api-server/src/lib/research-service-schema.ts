/**
 * Exported separately so the Zod schema can be imported in tests
 * without pulling in the full OpenAI + DB dependencies.
 */
import { z } from "zod";

export const DealOptionSchema = z.object({
  provider: z.string(),
  product_name: z.string(),
  price_status: z.enum([
    "confirmed_public",
    "indicative",
    "personal_quote_required",
    "unavailable",
  ]),
  annual_cost_gbp: z.number().nullable(),
  monthly_cost_gbp: z.number().nullable(),
  contract_length_months: z.number().nullable(),
  headline_terms: z.array(z.string()),
  important_exclusions: z.array(z.string()),
  source_urls: z.array(z.string()),
});

export const DealReportSchema = z.object({
  service_type: z.string(),
  as_of_date: z.string(),
  scope_statement: z.string(),
  current_deal_assessment: z.string(),
  options: z.array(DealOptionSchema),
  recommended_next_step: z.string(),
  estimated_annual_saving_gbp: z.number().nullable(),
  missing_information: z.array(z.string()),
  comparison_checklist: z.array(z.string()),
  application_pack: z.array(z.string()),
  warnings: z.array(z.string()),
  sources: z.array(z.string()),
  comparison_based_on: z.array(z.string()),
});

export type DealOption = z.infer<typeof DealOptionSchema>;
export type DealReport = z.infer<typeof DealReportSchema>;
