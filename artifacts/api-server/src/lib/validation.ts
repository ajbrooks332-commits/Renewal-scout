const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!ISO_DATE_RE.test(value)) return false;
  // Parse components manually and compare back to prevent rollover
  // (e.g. "2026-02-30" would roll over to 2026-03-02 in JS Date)
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(year, month - 1, day); // local constructor avoids UTC offset issues
  return (
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

export interface FieldError {
  field: string;
  message: string;
}

const SHORT_TEXT_FIELDS: Array<[string, number]> = [
  ["serviceType", 100],
  ["provider", 255],
  ["productName", 255],
  ["location", 255],
];

const LONG_TEXT_FIELDS: Array<[string, number]> = [
  ["currentTerms", 5000],
  ["preferences", 5000],
  ["quoteFacts", 5000],
];

/**
 * Validate service input fields and return a list of field errors.
 * Returns an empty array when all fields are valid.
 */
export function validateServiceInput(
  data: Record<string, unknown>,
): FieldError[] {
  const errors: FieldError[] = [];

  // Costs must be zero or positive
  const monthly = data["monthlyCostGbp"];
  if (monthly !== null && monthly !== undefined) {
    if (typeof monthly !== "number" || monthly < 0) {
      errors.push({
        field: "monthlyCostGbp",
        message: "Monthly cost must be zero or a positive number.",
      });
    }
  }

  const annual = data["annualCostGbp"];
  if (annual !== null && annual !== undefined) {
    if (typeof annual !== "number" || annual < 0) {
      errors.push({
        field: "annualCostGbp",
        message: "Annual cost must be zero or a positive number.",
      });
    }
  }

  // Dates must be valid ISO YYYY-MM-DD
  const renewalDate = data["renewalDate"];
  if (renewalDate !== null && renewalDate !== undefined) {
    if (!isValidIsoDate(renewalDate)) {
      errors.push({
        field: "renewalDate",
        message: "Renewal date must be a valid ISO date (YYYY-MM-DD).",
      });
    }
  }

  const contractEndDate = data["contractEndDate"];
  if (contractEndDate !== null && contractEndDate !== undefined) {
    if (!isValidIsoDate(contractEndDate)) {
      errors.push({
        field: "contractEndDate",
        message: "Contract end date must be a valid ISO date (YYYY-MM-DD).",
      });
    }
  }

  // Max lengths on short text fields
  for (const [field, max] of SHORT_TEXT_FIELDS) {
    const val = data[field];
    if (typeof val === "string" && val.length > max) {
      errors.push({
        field,
        message: `${field} must be at most ${max} characters.`,
      });
    }
  }

  // Max lengths on long text fields
  for (const [field, max] of LONG_TEXT_FIELDS) {
    const val = data[field];
    if (typeof val === "string" && val.length > max) {
      errors.push({
        field,
        message: `${field} must be at most ${max} characters.`,
      });
    }
  }

  return errors;
}

/**
 * Trim whitespace from short text fields in a service input object.
 * Returns a new object with trimmed values.
 */
export function trimServiceInput(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data };
  const fieldsToTrim = ["provider", "productName", "location", "serviceType"];
  for (const field of fieldsToTrim) {
    if (typeof result[field] === "string") {
      result[field] = (result[field] as string).trim();
    }
  }
  return result;
}
