/**
 * Strict primitive validators for the Renewal Scout API.
 *
 * These are the building blocks used by both server-side route validators
 * and client-side form schemas. Import from "@workspace/api-zod".
 */
import { z } from "zod";

// ── Calendar date ─────────────────────────────────────────────────────────────

/**
 * Validates a real YYYY-MM-DD calendar date.
 * Rejects impossible dates (e.g. 2026-02-30) and non-standard formats.
 */
export const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a date in YYYY-MM-DD format")
  .refine((v) => {
    const [year, month, day] = v.split("-").map(Number);
    const d = new Date(year!, month! - 1, day!);
    return (
      d.getFullYear() === year &&
      d.getMonth() === month! - 1 &&
      d.getDate() === day
    );
  }, "Must be a valid calendar date");

// ── Integer validators ────────────────────────────────────────────────────────

/**
 * Positive safe integer — for route IDs and primary keys.
 * Rejects 0, negatives, decimals, and values beyond Number.MAX_SAFE_INTEGER.
 */
export const SafePositiveInt = z
  .number()
  .int("Must be an integer")
  .positive("Must be a positive integer")
  .safe("Must be within safe integer range");

/**
 * Non-negative safe integer — for counts, quantities, and pence amounts.
 * Rejects negatives, decimals, and values beyond Number.MAX_SAFE_INTEGER.
 */
export const NonnegativeInt = z
  .number()
  .int("Must be an integer")
  .min(0, "Must be non-negative")
  .safe("Must be within safe integer range");

// ── Number validators ─────────────────────────────────────────────────────────

/**
 * Finite non-negative number — for GBP decimal values at the API boundary.
 * Rejects Infinity, -Infinity, NaN, and negatives.
 */
export const FiniteNonnegativeNumber = z
  .number()
  .finite("Must be a finite number")
  .nonnegative("Must be non-negative");

// ── Service type ──────────────────────────────────────────────────────────────

export const SERVICE_TYPES = [
  "Broadband",
  "Electricity",
  "Gas and electricity",
  "Car insurance",
  "Home insurance",
  "Life insurance",
  "Credit card",
  "Loan",
  "Mobile phone",
  "Other",
] as const;

/**
 * Exhaustive service type enum — the canonical list used by both server
 * validation and the frontend dropdown.
 */
export const ServiceTypeEnum = z.enum(SERVICE_TYPES);
export type ServiceType = z.infer<typeof ServiceTypeEnum>;

// ── Route ID parsing ──────────────────────────────────────────────────────────

/**
 * Parse a URL route segment as a positive safe integer ID.
 *
 * Returns null when:
 *  - the segment is absent
 *  - contains non-digit characters (e.g. "1abc")
 *  - is zero or negative ("0", "-5")
 *  - exceeds Number.MAX_SAFE_INTEGER
 *
 * Unlike parseInt(), this rejects trailing non-digit characters such that
 * "1abc" → null rather than 1.
 */
export function parseRouteId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = parseInt(raw, 10);
  return n > 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
}
