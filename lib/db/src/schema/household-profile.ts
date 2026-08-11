import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Singleton row (id = 1 enforced by DB CHECK constraint).
 * Use INSERT … ON CONFLICT (id) DO UPDATE SET … to upsert safely.
 * Never run an unqualified UPDATE against this table.
 *
 * All nullable fields default to NULL which means "not yet answered".
 * Fields explicitly marked "I don't know" by the user are tracked via
 * `unknownFields` — a JSONB array of field names. This lets the
 * completeness check distinguish "unanswered" from "acknowledged unknown".
 */
export const householdProfileTable = pgTable(
  "household_profile",
  {
    /** Always 1 — enforced by the singleton CHECK constraint below. */
    id: integer("id").primaryKey().notNull(),

    // ── Location & property ────────────────────────────────────────────────
    postcode: text("postcode"),
    propertyType: text("property_type"), // detached | semi-detached | terraced | flat | other
    tenure: text("tenure"),              // owner | tenant | other
    bedrooms: integer("bedrooms"),
    yearBuilt: integer("year_built"),

    // ── Household composition ──────────────────────────────────────────────
    numAdults: integer("num_adults"),
    numChildren: integer("num_children"),

    // ── Energy & technology ────────────────────────────────────────────────
    heatingType: text("heating_type"),   // gas | electric | oil | heat_pump | other
    hasEv: boolean("has_ev"),
    evChargerType: text("ev_charger_type"), // 7kw | 22kw | none | other
    hasSolar: boolean("has_solar"),
    solarExportTariff: text("solar_export_tariff"),
    annualElectricityKwh: integer("annual_electricity_kwh"),
    annualGasKwh: integer("annual_gas_kwh"),

    // ── Bundles & subscriptions ────────────────────────────────────────────
    hasSkyTv: boolean("has_sky_tv"),
    hasSkyMobile: boolean("has_sky_mobile"),
    hasVirginMedia: boolean("has_virgin_media"),

    // ── Vehicles ───────────────────────────────────────────────────────────
    /** Number of cars owned — drives completeness logic. */
    numCars: integer("num_cars"),

    /**
     * Vehicle records for multi-vehicle households.
     * Array of VehicleRecord objects; see VehicleRecord type below.
     * Populated via the API; single-car households have one element.
     * The old scalar car_* columns are retained for backward compatibility
     * and are kept in sync with vehicles[0] on write.
     */
    vehicles: jsonb("vehicles").notNull().default([]),

    // ── Single-car columns (kept for backward compatibility) ──────────────
    carMake: text("car_make"),
    carModel: text("car_model"),
    carYear: integer("car_year"),
    /**
     * Car value stored as integer pence (e.g. £20,000 → 2,000,000).
     * Convert at the API boundary; divide by 100 when returning to consumers.
     */
    carValuePence: integer("car_value_pence"),
    annualMileage: integer("annual_mileage"),
    drivingExperience: text("driving_experience"), // new_driver | <5yrs | 5_10yrs | 10plus
    claimsLast5Years: integer("claims_last_5_years"),

    // ── Health & life insurance ────────────────────────────────────────────
    smoker: boolean("smoker"),

    // ── Accessibility & preferences ────────────────────────────────────────
    accessibilityNeeds: text("accessibility_needs"),
    generalPreferences: text("general_preferences"),

    // ── Answer-state tracking ──────────────────────────────────────────────
    /**
     * JSONB array of field names where the user explicitly said
     * "I don't know / prefer not to say". These fields are excluded from
     * blocking completeness checks even though their value is null.
     *
     * Example: ["smoker", "annualMileage"]
     */
    unknownFields: jsonb("unknown_fields").notNull().default([]),

    // ── Metadata ───────────────────────────────────────────────────────────
    questionnaireVersion: text("questionnaire_version").notNull().default("1"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * Singleton guard: the household profile table may only ever contain
     * a single row with id = 1.  Combined with the INTEGER PRIMARY KEY,
     * this makes a second insert or an update changing id impossible.
     */
    check("household_profile_singleton", sql`${table.id} = 1`),
  ],
);

export type HouseholdProfile = typeof householdProfileTable.$inferSelect;

/**
 * A single vehicle entry stored in the `vehicles` JSONB array.
 *
 * All fields are optional/nullable so that partial questionnaire saves work
 * correctly — a user can set numCars then fill in make/model in a later session.
 * The completeness check determines whether the data is sufficient for
 * personalised research.
 */
export interface VehicleRecord {
  make?: string | null;
  model?: string | null;
  year?: number | null;
  valuePence?: number | null;
  annualMileage?: number | null;
  drivingExperience?: string | null;
  claimsLast5Years?: number | null;
}
