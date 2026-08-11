import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Singleton row (id = 1 enforced by DB CHECK constraint).
 * Use INSERT … ON CONFLICT (id) DO UPDATE SET … to upsert safely.
 * Never run an unqualified UPDATE against this table.
 *
 * All fields are nullable — NULL means "the user has not answered yet".
 * A separate `unknownFields` convention is used by the application layer
 * (Task C) to distinguish "unanswered" from "explicitly unknown"; the DB
 * stores both as NULL for now and the application adds the distinction.
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
    numCars: integer("num_cars"),
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
