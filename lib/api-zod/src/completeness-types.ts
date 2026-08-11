/**
 * Shared types for the completeness check API response.
 * Used by both the API server (completeness.ts) and the React frontend.
 */

export interface MissingField {
  label: string;
  /** Which UI tab/page the user should navigate to in order to fill in this field. */
  destination: "household" | "requirements" | "current-deal";
}

export interface CompletenessReport {
  /** Fields that MUST be present for personalised research. Missing ones block research unless researchMode is "generic". */
  required: MissingField[];
  /** Fields that improve accuracy. Missing ones show a warning but don't block research. */
  recommended: MissingField[];
  /** Advisory prompts (e.g. "add current deal cost for savings comparison"). */
  optional: string[];
  /** true when required fields are missing. */
  blocking: boolean;
  /**
   * Derived research mode:
   *   "personalised" — all required fields present; AI can personalise results.
   *   "generic"      — required fields missing; results are public examples with a disclaimer.
   */
  researchMode: "personalised" | "generic";
}
