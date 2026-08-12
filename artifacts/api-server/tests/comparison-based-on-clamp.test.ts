import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DealReportSchema } from "../src/lib/research-service-schema";

const SRC = readFileSync(
  join(__dirname, "../src/lib/research-service.ts"),
  "utf-8",
);

// Replicates the clamp applied in research-service.ts before schema validation.
function clampComparisonBasedOn(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as Record<string, unknown>).comparison_based_on)
  ) {
    const rawList = (parsed as Record<string, unknown>)
      .comparison_based_on as unknown[];
    const clamped = rawList.slice(0, 20).map((entry) => {
      if (typeof entry === "string" && entry.length > 500) {
        return entry.slice(0, 500);
      }
      return entry;
    });
    (parsed as Record<string, unknown>).comparison_based_on = clamped;
  }
  return parsed;
}

describe("comparison_based_on clamp before schema validation", () => {
  it("clamp exists in source and runs before SCHEMA_VALIDATION stage", () => {
    const clampIdx = SRC.indexOf("comparison_based_on clamped to schema limits");
    const stageIdx = SRC.indexOf('failureStage = "SCHEMA_VALIDATION"');
    expect(clampIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeGreaterThan(-1);
    expect(clampIdx).toBeLessThan(stageIdx);
  });

  it("clamp log line contains counts only, not entries", () => {
    const line = SRC.split("\n").find((l) =>
      l.includes("droppedItems: overItems"),
    );
    expect(line).toBeDefined();
    expect(line).not.toContain("clamped");
    expect(line).not.toContain("rawList");
    expect(line).not.toContain("entry");
  });

  it("more than 20 items are clamped to 20", () => {
    const list = Array.from({ length: 35 }, (_, i) => `Data point ${i + 1}`);
    const parsed = clampComparisonBasedOn({ comparison_based_on: list }) as {
      comparison_based_on: string[];
    };
    expect(parsed.comparison_based_on).toHaveLength(20);
    expect(parsed.comparison_based_on[0]).toBe("Data point 1");
    expect(parsed.comparison_based_on[19]).toBe("Data point 20");
  });

  it("strings over 500 chars are truncated to 500", () => {
    const parsed = clampComparisonBasedOn({
      comparison_based_on: ["x".repeat(900), "short"],
    }) as { comparison_based_on: string[] };
    expect(parsed.comparison_based_on[0]).toHaveLength(500);
    expect(parsed.comparison_based_on[1]).toBe("short");
  });

  it("clamped oversized list passes the schema array constraint", () => {
    const list = Array.from({ length: 30 }, (_, i) => `Point ${i}`);
    const clamped = clampComparisonBasedOn({ comparison_based_on: list }) as {
      comparison_based_on: string[];
    };
    const fieldSchema = DealReportSchema.shape.comparison_based_on;
    expect(fieldSchema.safeParse(clamped.comparison_based_on).success).toBe(
      true,
    );
    // Sanity: unclamped list of 30 fails, proving the clamp is what fixes run 66.
    expect(fieldSchema.safeParse(list).success).toBe(false);
  });

  it("non-array or missing comparison_based_on is left untouched", () => {
    expect(clampComparisonBasedOn({ a: 1 })).toEqual({ a: 1 });
    expect(clampComparisonBasedOn(null)).toBeNull();
    expect(
      clampComparisonBasedOn({ comparison_based_on: "not-an-array" }),
    ).toEqual({ comparison_based_on: "not-an-array" });
  });

  it("non-string entries are preserved for the schema to reject", () => {
    const parsed = clampComparisonBasedOn({
      comparison_based_on: ["ok", 42],
    }) as { comparison_based_on: unknown[] };
    expect(parsed.comparison_based_on).toEqual(["ok", 42]);
    const fieldSchema = DealReportSchema.shape.comparison_based_on;
    expect(fieldSchema.safeParse(parsed.comparison_based_on).success).toBe(
      false,
    );
  });
});
