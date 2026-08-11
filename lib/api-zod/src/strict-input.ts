/**
 * Strict input schemas for all write endpoints.
 *
 * These replace or augment the Orval-generated loose schemas:
 *  - `.strict()` rejects unknown keys with a parse error (→ 400)
 *  - Dates validated as real calendar dates (no Feb 30, etc.)
 *  - Costs validated as finite non-negative numbers
 *  - Integer fields reject decimals and infinities
 *  - Boolean fields reject string "false" (must be actual booleans)
 *  - Service type validated against the exhaustive enum
 *  - UK postcodes validated and normalised (when provided)
 */
import { z } from "zod";
import {
  CalendarDate,
  FiniteNonnegativeNumber,
  NonnegativeInt,
  ServiceTypeEnum,
} from "./primitives";

// ── Services ──────────────────────────────────────────────────────────────────

/**
 * Strict body for POST /services.
 * Unknown keys → 400. All fields fully validated.
 */
export const StrictCreateServiceBody = z
  .object({
    serviceType: ServiceTypeEnum,
    // Trim whitespace before min-length check so "   " (spaces only) is rejected
    provider: z.string().trim().min(1, "Provider is required").max(160),
    productName: z.string().max(255).nullish(),
    // Costs arrive as GBP decimal; must be finite and non-negative
    monthlyCostGbp: FiniteNonnegativeNumber.nullish(),
    annualCostGbp: FiniteNonnegativeNumber.nullish(),
    // Dates must be real calendar dates
    renewalDate: CalendarDate.nullish(),
    contractEndDate: CalendarDate.nullish(),
    // Period fields must be non-negative integers
    noticeDays: NonnegativeInt.max(365).optional(),
    researchWindowDays: NonnegativeInt.min(1).max(365).optional(),
    location: z.string().max(255).nullish(),
    currentTerms: z.string().max(5000).nullish(),
    preferences: z.string().max(5000).nullish(),
    quoteFacts: z.string().max(5000).nullish(),
    autoResearch: z.boolean().optional(),
  })
  .strict();

/**
 * Strict body for PUT /services/:id.
 * Same shape as create — it is a full replacement PUT.
 */
export const StrictUpdateServiceBody = StrictCreateServiceBody;

// ── Household profile ─────────────────────────────────────────────────────────

/**
 * Strict body for PUT /household-profile.
 *
 * True PATCH semantics: all fields are optional (absent = untouched).
 * When a field IS present:
 *   - null  → explicitly clears the stored value
 *   - value → validated against the field's type constraint
 *
 * Unknown keys → 400.
 * String "false" for boolean fields → 400 (must be an actual boolean).
 * Infinite / decimal values for integer fields → 400.
 * Invalid UK postcode → 400.
 */
export const StrictUpdateHouseholdProfileBody = z
  .object({
    // Postcode: null clears; string must be a valid UK postcode
    postcode: z
      .string()
      .max(10)
      .nullable()
      .superRefine((v, ctx) => {
        if (v == null || v === "") return;
        const clean = v.replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z]{1,2}[0-9][0-9A-Z]?[0-9][A-Z]{2}$/.test(clean)) {
          ctx.addIssue({
            code: "custom",
            message: "Must be a valid UK postcode (e.g. SW1A 1AA)",
          });
        }
      })
      .optional(),

    propertyType: z
      .enum(["detached", "semi-detached", "terraced", "flat", "bungalow", "other"])
      .nullable()
      .optional(),

    tenure: z.enum(["owner", "tenant", "other"]).nullable().optional(),

    bedrooms: NonnegativeInt.max(50).nullable().optional(),
    yearBuilt: z.number().int().min(1800).max(2030).nullable().optional(),
    numAdults: NonnegativeInt.max(100).nullable().optional(),
    numChildren: NonnegativeInt.max(100).nullable().optional(),

    heatingType: z
      .enum(["gas", "electric", "oil", "heat_pump", "other"])
      .nullable()
      .optional(),

    hasEv: z.boolean().nullable().optional(),

    evChargerType: z
      .enum(["7kw", "22kw", "none", "other"])
      .nullable()
      .optional(),

    hasSolar: z.boolean().nullable().optional(),
    solarExportTariff: z.string().max(100).nullable().optional(),

    annualElectricityKwh: NonnegativeInt.nullable().optional(),
    annualGasKwh: NonnegativeInt.nullable().optional(),

    hasSkyTv: z.boolean().nullable().optional(),
    hasSkyMobile: z.boolean().nullable().optional(),
    hasVirginMedia: z.boolean().nullable().optional(),

    numCars: NonnegativeInt.max(20).nullable().optional(),
    carMake: z.string().max(80).nullable().optional(),
    carModel: z.string().max(80).nullable().optional(),
    carYear: z.number().int().min(1900).max(2030).nullable().optional(),
    // carValue is the API GBP decimal (stored as pence internally)
    carValue: FiniteNonnegativeNumber.nullable().optional(),

    annualMileage: NonnegativeInt.nullable().optional(),

    drivingExperience: z
      .enum(["new_driver", "lt5yrs", "5_10yrs", "10plus"])
      .nullable()
      .optional(),

    claimsLast5Years: NonnegativeInt.max(20).nullable().optional(),
    smoker: z.boolean().nullable().optional(),
    accessibilityNeeds: z.string().max(500).nullable().optional(),
    generalPreferences: z.string().max(500).nullable().optional(),
  })
  .strict();

export type StrictHouseholdProfilePatch = z.infer<
  typeof StrictUpdateHouseholdProfileBody
>;

// ── Service requirements ──────────────────────────────────────────────────────

/**
 * Strict body for PUT /services/:id/requirements.
 * Unknown top-level keys → 400. The `fields` record is untyped (values may
 * be any JSON-serialisable value or null).
 */
export const StrictUpdateServiceRequirementsBody = z
  .object({
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();
