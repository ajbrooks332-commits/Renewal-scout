/**
 * Versioned, service-specific deal schemas.
 *
 * These define the full set of field names accepted for each service category.
 * The manual deal PUT endpoint validates submitted `values` against the
 * service-specific schema for the target service type.
 *
 * Provenance (source) is NEVER submitted by clients — it is always assigned
 * server-side:
 *  - Manual PUT endpoint   → source: "user"
 *  - Extraction endpoint   → source: "extracted_unconfirmed"
 *  - Confirmation endpoint → source: "extracted_confirmed"
 */
import { z } from "zod/v4";

// ── Primitives ─────────────────────────────────────────────────────────────────

const OptStr = z.string().max(1000).nullish();
// z.coerce.number() is intentional: HTML <input type="number"> submits a string
// via e.target.value. Coercion converts "42.5" → 42.5 without rejecting valid entries.
// .finite() guards against NaN/Infinity produced by non-numeric strings.
const OptNum = z.coerce.number().finite().nullish();
const OptNonneg = z.coerce.number().finite().min(0).nullish();
const OptPosInt = z.coerce.number().int().min(0).nullish();
const OptDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD")
  .nullish();

// ── Common fields (all service types) ──────────────────────────────────────────

const CommonDeal = z.object({
  /** Current provider name */
  provider: OptStr,
  /** Product or plan name (e.g. "BT Full Fibre 100") */
  productName: z.string().max(500).nullish(),
  /** Tariff name or reference number */
  tariffName: z.string().max(500).nullish(),
  /** Monthly cost in GBP */
  monthlyCostGbp: OptNonneg,
  /** Annual cost in GBP */
  annualCostGbp: OptNonneg,
  /** Renewal or review date */
  renewalDate: OptDate,
  /** Contract end date */
  contractEndDate: OptDate,
  /** One-off setup fee in GBP */
  setupFeeGbp: OptNonneg,
  /** Early-exit / cancellation fee in GBP */
  exitFeeGbp: OptNonneg,
  /** Notice period in days */
  noticeDays: OptPosInt,
  /** Date a promotional rate expires */
  promotionEndDate: OptDate,
  /** Percentage price increase clause (e.g. 3.9 for 3.9%) */
  priceIncreasePct: OptNum,
  /** Payment method (Direct Debit, credit card, etc.) */
  paymentMethod: OptStr,
  /** Products included in a bundle (e.g. "Sky Sports + Netflix") */
  bundleProducts: OptStr,
  /** Bundle discount amount or percentage */
  bundleDiscount: OptStr,
  /** What is included in this deal */
  inclusions: OptStr,
  /** Key exclusions or caveats */
  exclusions: OptStr,
  /** Free-text notes */
  notes: z.string().max(5000).nullish(),
});

// ── Service-specific extensions ────────────────────────────────────────────────

const EnergyDeal = CommonDeal.extend({
  /** Electricity unit rate (pence per kWh) */
  unitRatePencePkwh: OptNonneg,
  /** Electricity standing charge (pence per day) */
  standingChargePencePday: OptNonneg,
  /** Gas unit rate (pence per kWh) */
  gasUnitRatePencePkwh: OptNonneg,
  /** Gas standing charge (pence per day) */
  gasStandingChargePencePday: OptNonneg,
});

const BroadbandDeal = CommonDeal.extend({
  /** Average or guaranteed download speed in Mbps */
  downloadSpeedMbps: OptNonneg,
  /** Average or guaranteed upload speed in Mbps */
  uploadSpeedMbps: OptNonneg,
  /** Bundle terms (e.g. "18-month minimum, unlimited data") */
  bundleTerms: z.string().max(1000).nullish(),
});

const InsuranceDeal = CommonDeal.extend({
  /** Annual insurance premium in GBP */
  annualPremiumGbp: OptNonneg,
  /** Cover level or type (e.g. "Comprehensive", "Third Party") */
  coverType: z.string().max(500).nullish(),
  /** Policy excess in GBP */
  excessGbp: OptNonneg,
  /** Optional add-ons included or available */
  addOns: z.string().max(2000).nullish(),
});

const CreditLoanDeal = CommonDeal.extend({
  /** Annual Percentage Rate */
  aprPct: OptNonneg,
  /** Current outstanding balance in GBP */
  balanceGbp: OptNonneg,
  /** Arrangement or processing fee in GBP */
  arrangementFeeGbp: OptNonneg,
  /** Date the promotional rate (e.g. 0% balance transfer) expires */
  promoExpiryDate: OptDate,
});

// ── Strict variants — reject any unknown keys submitted by clients ─────────────
//
// These are used for validation at the API boundary so clients cannot sneak in
// undeclared field names. Using .strict() on each schema (rather than the base
// CommonDeal) ensures the extended schemas correctly reject keys beyond their
// own declared set.
//
// NOTE: CommonDeal.extend({...}).strict() call ordering matters in Zod — calling
// .strict() on the *extended* result (not on CommonDeal itself) ensures the
// strict flag covers both the base and extension fields.
const EnergyDealStrict = EnergyDeal.strict();
const BroadbandDealStrict = BroadbandDeal.strict();
const InsuranceDealStrict = InsuranceDeal.strict();
const CreditLoanDealStrict = CreditLoanDeal.strict();
const CommonDealStrict = CommonDeal.strict();

// ── Per-service-type schema map ────────────────────────────────────────────────

// Keys MUST match the canonical SERVICE_TYPES list in lib/api-zod/src/primitives.ts.
// Any service type not listed here falls back to CommonDeal via getDealSchema().
export const DEAL_SCHEMAS_BY_SERVICE_TYPE: Record<string, z.ZodTypeAny> = {
  // Energy — single fuel (electricity) or combined (gas & electricity)
  Electricity: EnergyDealStrict,
  "Gas and electricity": EnergyDealStrict,
  // Broadband
  Broadband: BroadbandDealStrict,
  // Insurance
  "Car insurance": InsuranceDealStrict,
  "Home insurance": InsuranceDealStrict,
  "Life insurance": InsuranceDealStrict,
  // Credit / Loan
  "Credit card": CreditLoanDealStrict,
  Loan: CreditLoanDealStrict,
  // Common fallback — service types that have no extra fields
  "Mobile phone": CommonDealStrict,
  Other: CommonDealStrict,
};

/** Fallback schema when the service type is unknown */
export const FALLBACK_DEAL_SCHEMA = CommonDealStrict;

/**
 * Returns the deal schema for a given service type.
 * Falls back to CommonDeal for unrecognised types.
 */
export function getDealSchema(serviceType: string): z.ZodTypeAny {
  return DEAL_SCHEMAS_BY_SERVICE_TYPE[serviceType] ?? FALLBACK_DEAL_SCHEMA;
}

/**
 * Validates a `values` map (field → raw value) against the service-specific
 * deal schema. Returns `{ success, data }` on success where `data` holds the
 * Zod-coerced values (e.g. HTML-string "42.5" → number 42.5).
 * Callers MUST persist `data` rather than the raw input so coercion is reflected.
 */
export function validateDealValues(
  serviceType: string,
  values: Record<string, unknown>,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
  const schema = getDealSchema(serviceType);
  const result = schema.safeParse(values);
  if (result.success) return { success: true, data: result.data as Record<string, unknown> };
  return {
    success: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; "),
  };
}

// Export named schemas for direct use
export { CommonDeal, EnergyDeal, BroadbandDeal, InsuranceDeal, CreditLoanDeal };
