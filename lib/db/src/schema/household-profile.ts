import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * One row per installation (singleton). All fields are nullable — NULL means
 * "the user has not told us yet". A separate `*_unknown` convention is NOT used;
 * instead, the frontend stores null for "I don't know" so the AI can report the
 * gap rather than guess.
 */
export const householdProfileTable = pgTable("household_profile", {
  id: serial("id").primaryKey(),

  // ── Location & property ────────────────────────────────────────────────────
  postcode: text("postcode"),
  propertyType: text("property_type"), // detached | semi-detached | terraced | flat | other
  tenure: text("tenure"),              // owner | tenant | other
  bedrooms: integer("bedrooms"),
  yearBuilt: integer("year_built"),

  // ── Household composition ──────────────────────────────────────────────────
  numAdults: integer("num_adults"),
  numChildren: integer("num_children"),

  // ── Energy & technology ────────────────────────────────────────────────────
  heatingType: text("heating_type"),   // gas | electric | oil | heat_pump | other
  hasEv: boolean("has_ev"),
  evChargerType: text("ev_charger_type"), // 7kw | 22kw | none | other
  hasSolar: boolean("has_solar"),
  solarExportTariff: text("solar_export_tariff"),
  annualElectricityKwh: integer("annual_electricity_kwh"),
  annualGasKwh: integer("annual_gas_kwh"),

  // ── Bundles & subscriptions ────────────────────────────────────────────────
  hasSkyTv: boolean("has_sky_tv"),
  hasSkyMobile: boolean("has_sky_mobile"),
  hasVirginMedia: boolean("has_virgin_media"),

  // ── Vehicles ───────────────────────────────────────────────────────────────
  numCars: integer("num_cars"),
  carMake: text("car_make"),
  carModel: text("car_model"),
  carYear: integer("car_year"),
  carValue: integer("car_value_gbp"),
  annualMileage: integer("annual_mileage"),
  drivingExperience: text("driving_experience"), // new_driver | <5yrs | 5_10yrs | 10plus
  claimsLast5Years: integer("claims_last_5_years"),

  // ── Health & life insurance ────────────────────────────────────────────────
  smoker: boolean("smoker"),

  // ── Accessibility & preferences ────────────────────────────────────────────
  accessibilityNeeds: text("accessibility_needs"),
  generalPreferences: text("general_preferences"),

  // ── Metadata ───────────────────────────────────────────────────────────────
  questionnaireVersion: text("questionnaire_version").notNull().default("1"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type HouseholdProfile = typeof householdProfileTable.$inferSelect;
