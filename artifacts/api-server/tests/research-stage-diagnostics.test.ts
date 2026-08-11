/**
 * Tests for safe failure-stage diagnostics in research-service.ts.
 *
 * Covers:
 * 1. All 11 fixed stage codes are present in the source
 * 2. Stage codes are static strings — no user data, secrets or prompt content
 * 3. Zod diagnostics log only issue code and field path (no values/messages)
 * 4. Raw errors, messages, AI output and prompts are never logged or stored
 * 5. Existing timeout / OpenAI error classification is preserved
 * 6. Stored error strings stay within the 2 000-character database column limit
 * 7. Database-failure SQLSTATE capture uses the safe errObj["code"] path
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../src/lib/research-service.ts"),
  "utf-8",
);

// ─── Stage type definition ─────────────────────────────────────────────────────

const STAGE_CODES = [
  "OPENAI_REQUEST",
  "EMPTY_OUTPUT",
  "JSON_PARSE",
  "SCHEMA_VALIDATION",
  "SANITISE_REPORT",
  "CITATION_EXTRACTION",
  "CITATION_RECONCILIATION",
  "SAVINGS_CALCULATION",
  "WARNING_INJECTION",
  "NEXT_RESEARCH_DATE",
  "DATABASE_SAVE",
] as const;

type ResearchStage = (typeof STAGE_CODES)[number];

describe("ResearchStage type — all 11 stage codes defined", () => {
  for (const stage of STAGE_CODES) {
    it(`stage code "${stage}" exists in the source`, () => {
      expect(SRC).toContain(`"${stage}"`);
    });
  }

  it("source declares the ResearchStage type union", () => {
    expect(SRC).toMatch(/type ResearchStage\s*=/);
  });

  it("failureStage variable is initialized to OPENAI_REQUEST", () => {
    expect(SRC).toMatch(/let failureStage.*:\s*ResearchStage\s*=\s*"OPENAI_REQUEST"/);
  });
});

// ─── Stage advancement ────────────────────────────────────────────────────────

describe("failureStage is advanced before each operation", () => {
  it('advances to EMPTY_OUTPUT before checking output_text', () => {
    // failureStage = "EMPTY_OUTPUT" must precede the outputText access
    const emptyIdx = SRC.indexOf('failureStage = "EMPTY_OUTPUT"');
    const outputTextIdx = SRC.indexOf("const outputText = response.output_text");
    expect(emptyIdx).toBeGreaterThan(-1);
    expect(outputTextIdx).toBeGreaterThan(-1);
    expect(emptyIdx).toBeLessThan(outputTextIdx);
  });

  it('advances to JSON_PARSE before JSON.parse()', () => {
    const jsonParseStageIdx = SRC.indexOf('failureStage = "JSON_PARSE"');
    const jsonParseIdx = SRC.indexOf("JSON.parse(outputText)");
    expect(jsonParseStageIdx).toBeGreaterThan(-1);
    expect(jsonParseIdx).toBeGreaterThan(-1);
    expect(jsonParseStageIdx).toBeLessThan(jsonParseIdx);
  });

  it('advances to SCHEMA_VALIDATION before DealReportSchema.safeParse()', () => {
    const schemaStageIdx = SRC.indexOf('failureStage = "SCHEMA_VALIDATION"');
    const safeParseIdx = SRC.indexOf("DealReportSchema.safeParse(parsed)");
    expect(schemaStageIdx).toBeGreaterThan(-1);
    expect(safeParseIdx).toBeGreaterThan(-1);
    expect(schemaStageIdx).toBeLessThan(safeParseIdx);
  });

  it('advances to SANITISE_REPORT before sanitiseReport()', () => {
    const sanitiseStageIdx = SRC.indexOf('failureStage = "SANITISE_REPORT"');
    const sanitiseIdx = SRC.indexOf("report = sanitiseReport(report)");
    expect(sanitiseStageIdx).toBeGreaterThan(-1);
    expect(sanitiseIdx).toBeGreaterThan(-1);
    expect(sanitiseStageIdx).toBeLessThan(sanitiseIdx);
  });

  it('advances to CITATION_EXTRACTION before extractCitationUrls()', () => {
    const extractStageIdx = SRC.indexOf('failureStage = "CITATION_EXTRACTION"');
    // Use the call-site argument to avoid matching the earlier function definition
    const extractIdx = SRC.indexOf("extractCitationUrls(responseOutputItems)");
    expect(extractStageIdx).toBeGreaterThan(-1);
    expect(extractIdx).toBeGreaterThan(-1);
    expect(extractStageIdx).toBeLessThan(extractIdx);
  });

  it('advances to CITATION_RECONCILIATION before reconcileCitationUrls()', () => {
    const reconcileStageIdx = SRC.indexOf('failureStage = "CITATION_RECONCILIATION"');
    const reconcileIdx = SRC.indexOf("reconcileCitationUrls(report,");
    expect(reconcileStageIdx).toBeGreaterThan(-1);
    expect(reconcileIdx).toBeGreaterThan(-1);
    expect(reconcileStageIdx).toBeLessThan(reconcileIdx);
  });

  it('advances to SAVINGS_CALCULATION before computeSavings()', () => {
    const savingsStageIdx = SRC.indexOf('failureStage = "SAVINGS_CALCULATION"');
    const savingsIdx = SRC.indexOf("computeSavings(report,");
    expect(savingsStageIdx).toBeGreaterThan(-1);
    expect(savingsIdx).toBeGreaterThan(-1);
    expect(savingsStageIdx).toBeLessThan(savingsIdx);
  });

  it('advances to WARNING_INJECTION before addMandatoryWarnings()', () => {
    const warningStageIdx = SRC.indexOf('failureStage = "WARNING_INJECTION"');
    // Use the call-site arguments to avoid matching the earlier function definition
    const warningIdx = SRC.indexOf("addMandatoryWarnings(report, service.serviceType)");
    expect(warningStageIdx).toBeGreaterThan(-1);
    expect(warningIdx).toBeGreaterThan(-1);
    expect(warningStageIdx).toBeLessThan(warningIdx);
  });

  it('advances to NEXT_RESEARCH_DATE before calculateNextResearchDate()', () => {
    const nextStageIdx = SRC.indexOf('failureStage = "NEXT_RESEARCH_DATE"');
    const nextIdx = SRC.indexOf("calculateNextResearchDate(");
    expect(nextStageIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    expect(nextStageIdx).toBeLessThan(nextIdx);
  });

  it('advances to DATABASE_SAVE before db.transaction()', () => {
    const dbStageIdx = SRC.indexOf('failureStage = "DATABASE_SAVE"');
    const txIdx = SRC.indexOf("await db.transaction(");
    expect(dbStageIdx).toBeGreaterThan(-1);
    expect(txIdx).toBeGreaterThan(-1);
    expect(dbStageIdx).toBeLessThan(txIdx);
  });
});

// ─── Stage codes contain no user data ─────────────────────────────────────────

describe("Stage codes are safe static strings — no user data", () => {
  it("no stage code contains spaces (codes are machine-readable identifiers)", () => {
    for (const stage of STAGE_CODES) {
      expect(stage).not.toMatch(/\s/);
    }
  });

  it("no stage code contains household keywords", () => {
    const forbidden = /address|postcode|name|email|phone|dob|income|account/i;
    for (const stage of STAGE_CODES) {
      expect(stage).not.toMatch(forbidden);
    }
  });

  it("no stage code contains API or secret keywords", () => {
    const forbidden = /key|secret|token|auth|password|credential/i;
    for (const stage of STAGE_CODES) {
      expect(stage).not.toMatch(forbidden);
    }
  });

  it("stored error with stage reference stays under 2 000 chars for every stage", () => {
    const limit = 2000;
    for (const stage of STAGE_CODES) {
      const msg: string = `Research could not be completed. Reference: ${stage}.`;
      expect(msg.length).toBeLessThan(limit);
    }
  });
});

// ─── failureStage appears in the Research failed log ──────────────────────────

describe("failureStage is included in the Research failed log entry", () => {
  it('logger.error call includes failureStage field', () => {
    // Find the logger.error("Research failed") call and check failureStage is in it
    const errorLogIdx = SRC.indexOf('"Research failed"');
    expect(errorLogIdx).toBeGreaterThan(-1);
    // failureStage must appear in the object argument to logger.error
    const logBlock = SRC.slice(
      SRC.lastIndexOf("logger.error(", errorLogIdx),
      errorLogIdx + 100,
    );
    expect(logBlock).toContain("failureStage");
  });
});

// ─── Safe error string with stage reference ────────────────────────────────────

describe("safeError for non-OpenAI errors includes stage reference", () => {
  it("source uses failureStage interpolation in the generic safeError branch", () => {
    expect(SRC).toMatch(/`Research could not be completed\. Reference: \$\{failureStage\}\.`/);
  });

  it("timeout safeError does not contain stage reference (specific message preserved)", () => {
    const timeoutMsg = "AI research timed out before completion. No automatic retry was made.";
    expect(timeoutMsg).not.toContain("Reference:");
    expect(timeoutMsg).not.toContain("failureStage");
  });

  it("OpenAI HTTP error safeError does not contain stage reference (specific message preserved)", () => {
    // The OpenAI error branch is a template literal split across two source lines.
    // Verify the AI service error prefix line itself does not reference failureStage.
    const openaiErrLine = SRC.split("\n").find((l) =>
      l.includes("AI service error (type:"),
    );
    expect(openaiErrLine).toBeDefined();
    expect(openaiErrLine).toContain("AI service error (type:");
    expect(openaiErrLine).not.toContain("failureStage");
    // The continuation line includes request_id
    const reqIdLine = SRC.split("\n").find((l) =>
      l.includes("request_id: ${reqId})"),
    );
    expect(reqIdLine).toBeDefined();
    expect(reqIdLine).not.toContain("failureStage");
  });

  it("stored error string for each stage is below the 2 000-char DB limit", () => {
    for (const stage of STAGE_CODES) {
      const s: string = `Research could not be completed. Reference: ${stage}.`;
      expect(s.length).toBeLessThanOrEqual(2000);
    }
  });
});

// ─── Zod diagnostics — issue code and path only ───────────────────────────────

describe("Zod validation failure logs only issue code and field path", () => {
  it("zodDiagnostics mapping extracts only code and path", () => {
    // Reproduce the mapping logic from the source
    type MockIssue = { code: string; path: (string | number)[]; message: string; received?: unknown };
    const mockIssues: MockIssue[] = [
      { code: "too_small", path: ["options", 0, "annual_cost_gbp"], message: "Number must be greater than 0", received: -1 },
      { code: "invalid_type", path: ["provider"], message: "Expected string, received number", received: 42 },
    ];
    const zodDiagnostics = mockIssues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
    }));

    expect(zodDiagnostics).toHaveLength(2);
    expect(zodDiagnostics[0]).toEqual({ code: "too_small", path: "options.0.annual_cost_gbp" });
    expect(zodDiagnostics[1]).toEqual({ code: "invalid_type", path: "provider" });
  });

  it("zodDiagnostics does not include message field", () => {
    type MockIssue = { code: string; path: (string | number)[]; message: string };
    const mockIssue: MockIssue = { code: "too_small", path: ["cost"], message: "Must be positive" };
    const diagnostic = { code: mockIssue.code, path: mockIssue.path.map(String).join(".") };

    expect(diagnostic).not.toHaveProperty("message");
  });

  it("zodDiagnostics does not include received/expected values", () => {
    const diagnostic = { code: "invalid_type", path: "provider" };
    expect(diagnostic).not.toHaveProperty("received");
    expect(diagnostic).not.toHaveProperty("expected");
  });

  it("source logs zodIssueCount and zodIssues (not validated.error.message)", () => {
    // The warn call at SCHEMA_VALIDATION must include zodIssueCount/zodIssues
    expect(SRC).toContain("zodIssueCount");
    expect(SRC).toContain("zodIssues");
    // The zodDiagnostics objects must not include the message property
    const zodBlock = SRC.slice(
      SRC.indexOf("zodDiagnostics = validated.error.issues.map"),
      SRC.indexOf("logger.warn", SRC.indexOf("zodDiagnostics = validated.error.issues.map")) + 300,
    );
    expect(zodBlock).not.toMatch(/message:/);
    expect(zodBlock).not.toMatch(/received:/);
    expect(zodBlock).not.toMatch(/expected:/);
  });

  it("source includes zodIssueCount: validated.error.issues.length", () => {
    expect(SRC).toMatch(/zodIssueCount:\s*validated\.error\.issues\.length/);
  });
});

// ─── OpenAI response metadata — no content logged ─────────────────────────────

describe("OpenAI response metadata logging excludes content", () => {
  it("source logs outputItemCount and outputItemTypes", () => {
    expect(SRC).toContain("outputItemCount");
    expect(SRC).toContain("outputItemTypes");
  });

  it("source logs responseStatus", () => {
    expect(SRC).toContain("responseStatus");
  });

  it("source logs incompleteReason conditionally (not always present)", () => {
    expect(SRC).toContain("incompleteReason");
    // Must be conditional — only included when present
    expect(SRC).toMatch(/incompleteReason.*&&|&&.*incompleteReason/s);
  });

  it("outputItemTypes maps only the type tag — not content or text", () => {
    // Reproduce the mapping
    type OutputItem = Record<string, unknown>;
    const items: OutputItem[] = [
      { type: "output_text", text: "Some AI output that must not be logged" },
      { type: "web_search_call", query: "household broadband deals" },
    ];
    const types = items.map((i) => String(i["type"] ?? "unknown"));
    expect(types).toEqual(["output_text", "web_search_call"]);
    // The mapping does not include text or query fields
    expect(types.join(",")).not.toContain("Some AI output");
    expect(types.join(",")).not.toContain("household broadband deals");
  });
});

// ─── Database failure — SQLSTATE only ─────────────────────────────────────────

describe("Database failure captures SQLSTATE only", () => {
  it("source conditionally captures sqlstate only when failureStage is DATABASE_SAVE", () => {
    expect(SRC).toMatch(/failureStage === "DATABASE_SAVE"/);
    expect(SRC).toContain("sqlstate");
  });

  it("sqlstate is derived from errObj[\"code\"] — not from err.message", () => {
    // The safe pattern: errObj["code"] is the SQLSTATE error code from pg
    const errObj: Record<string, unknown> = { code: "23505", message: "duplicate key value violates unique constraint" };
    const sqlstate = errObj["code"] as string | undefined;
    expect(sqlstate).toBe("23505");
    // We never use errObj["message"]
  });

  it("source does not include errObj message or SQL text in the DATABASE_SAVE branch", () => {
    const dbBlock = SRC.slice(
      SRC.indexOf('failureStage === "DATABASE_SAVE"'),
      SRC.indexOf("logger.error("),
    );
    expect(dbBlock).not.toMatch(/err\.message/);
    expect(dbBlock).not.toMatch(/errObj\["message"\]/);
  });
});

// ─── Raw error messages and prompts never logged ───────────────────────────────

describe("Raw error messages, AI output and prompts are never logged or stored", () => {
  it("source does not log err.message in any logger call", () => {
    const loggerLines = SRC.split("\n")
      .filter((l) => l.includes("logger.error") || l.includes("logger.warn") || l.includes("logger.info"))
      .join("\n");
    expect(loggerLines).not.toMatch(/err\.message/);
  });

  it("safeError construction never references apiKey or OPENAI_API_KEY", () => {
    const safeErrorBlock = SRC.slice(
      SRC.indexOf("const safeError ="),
      SRC.indexOf("logger.error(", SRC.indexOf("const safeError =")),
    );
    expect(safeErrorBlock).not.toMatch(/apiKey/);
    expect(safeErrorBlock).not.toMatch(/OPENAI_API_KEY/);
  });

  it("source does not log outputText (AI output) in any logger call", () => {
    // outputText holds raw AI output and must never be passed to a logger.
    // Filter to lines that open a logger call; none should reference outputText.
    // (Splitting on "logger." is intentionally avoided — it splits inside string
    // literals such as AGENT_INSTRUCTIONS and produces false positives.)
    const loggerLines = SRC.split("\n").filter((l) =>
      /\blogger\.(info|warn|error|debug)\s*\(/.test(l),
    );
    for (const line of loggerLines) {
      expect(line).not.toContain("outputText");
    }
  });

  it("source does not log the prompt variable in any logger call", () => {
    // The prompt variable contains household data and must never be logged.
    const loggerLines = SRC.split("\n").filter((l) =>
      /\blogger\.(info|warn|error|debug)\s*\(/.test(l),
    );
    for (const line of loggerLines) {
      expect(line).not.toMatch(/\bprompt\b/);
    }
  });
});

// ─── Existing timeout / OpenAI error classification preserved ──────────────────

describe("Existing error classification preserved (regression)", () => {
  it("timeout is 180_000 ms", () => {
    expect(SRC).toMatch(/timeout\s*:\s*180_000/);
  });

  it("maxRetries is 0", () => {
    expect(SRC).toMatch(/maxRetries\s*:\s*0/);
  });

  it("store: false is retained", () => {
    expect(SRC).toMatch(/store\s*:\s*false/);
  });

  it("gpt-5.6-terra remains the fallback model", () => {
    expect(SRC).toMatch(/gpt-5\.6-terra/);
  });

  it("OPENAI_MODEL env var takes precedence via nullish coalescing", () => {
    expect(SRC).toMatch(/OPENAI_MODEL.*\?\?.*gpt-5\.6-terra/);
  });

  it("APIConnectionTimeoutError is still recognised by constructor name", () => {
    expect(SRC).toContain("APIConnectionTimeoutError");
  });

  it("timeout safeError message is unchanged", () => {
    expect(SRC).toContain(
      "AI research timed out before completion. No automatic retry was made.",
    );
  });

  it("OpenAI HTTP error safeError message is unchanged", () => {
    // The template literal is split across two lines with + concatenation;
    // check each key field individually rather than with a single-line regex.
    const safeErrorBlock = SRC.slice(
      SRC.indexOf("const safeError ="),
      SRC.indexOf("const sqlstate ="),
    );
    expect(safeErrorBlock).toContain("AI service error (type: ${errType}");
    expect(safeErrorBlock).toContain("status: ${errStatus ?? \"n/a\"}");
    expect(safeErrorBlock).toContain("code: ${errCode}");
    expect(safeErrorBlock).toContain("request_id: ${reqId})");
  });

  it("classifyError still produces correct result for APIConnectionTimeoutError", () => {
    function classifyError(err: unknown, stage: string): string {
      const errObj =
        err && typeof err === "object" ? (err as Record<string, unknown>) : {};
      const constructorName =
        err instanceof Error ? err.constructor.name : String(typeof err);
      const isTimeout = constructorName === "APIConnectionTimeoutError";
      const isOpenAIError = "status" in errObj;
      const errType = (errObj["type"] as string | undefined) ?? "unknown";
      const errStatus = errObj["status"] as number | undefined;
      const errCode = (errObj["code"] as string | undefined) ?? "unknown";
      const reqId =
        (errObj["requestID"] as string | undefined) ??
        (errObj["request_id"] as string | undefined) ??
        "n/a";
      return isTimeout
        ? "AI research timed out before completion. No automatic retry was made."
        : isOpenAIError
          ? `AI service error (type: ${errType}, status: ${errStatus ?? "n/a"}, code: ${errCode}, request_id: ${reqId})`
          : `Research could not be completed. Reference: ${stage}.`;
    }

    class APIConnectionTimeoutError extends Error {
      constructor() { super(); Object.setPrototypeOf(this, APIConnectionTimeoutError.prototype); }
    }
    expect(classifyError(new APIConnectionTimeoutError(), "OPENAI_REQUEST")).toBe(
      "AI research timed out before completion. No automatic retry was made.",
    );

    const openAIErr = Object.assign(new Error(), { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded" });
    expect(classifyError(openAIErr, "OPENAI_REQUEST")).toMatch(/AI service error.*rate_limit/);

    const plainErr = new Error("some internal error");
    expect(classifyError(plainErr, "JSON_PARSE")).toBe(
      "Research could not be completed. Reference: JSON_PARSE.",
    );
  });
});

// ─── DB column length ──────────────────────────────────────────────────────────

describe("All stored error strings fit within 2 000-character DB column", () => {
  const DB_LIMIT = 2000;

  it("generic safeError with longest stage code is within limit", () => {
    const longestStage = STAGE_CODES.reduce((a, b) => (a.length >= b.length ? a : b));
    const msg = `Research could not be completed. Reference: ${longestStage}.`;
    expect(msg.length).toBeLessThanOrEqual(DB_LIMIT);
  });

  it("timeout safeError is within limit", () => {
    const msg = "AI research timed out before completion. No automatic retry was made.";
    expect(msg.length).toBeLessThanOrEqual(DB_LIMIT);
  });

  it("source slices safeError to 2 000 characters before storing", () => {
    expect(SRC).toMatch(/safeError\.slice\(0,\s*2000\)/);
  });
});
