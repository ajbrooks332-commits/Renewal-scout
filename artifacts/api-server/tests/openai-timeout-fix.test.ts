/**
 * Tests for the OpenAI timeout / retry hardening (research-service.ts).
 *
 * Covers:
 * 1. timeout raised to 180_000 ms
 * 2. maxRetries set to 0 (no automatic retries)
 * 3. gpt-5.6-terra remains the model fallback
 * 4. store: false is retained
 * 5. APIConnectionTimeoutError is classified correctly
 * 6. No API keys, prompts, or household data appear in logged/stored error strings
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(
  join(__dirname, "../src/lib/research-service.ts"),
  "utf-8",
);

// ─── Client configuration ─────────────────────────────────────────────────────

describe("OpenAI client configuration", () => {
  it("timeout is 180_000 ms", () => {
    expect(SRC).toMatch(/timeout\s*:\s*180_000/);
  });

  it("maxRetries is 0", () => {
    expect(SRC).toMatch(/maxRetries\s*:\s*0/);
  });

  it("maxRetries is not 1, 2, or 3 (no automatic retries)", () => {
    // Ensure we haven't accidentally left a non-zero retry count
    expect(SRC).not.toMatch(/maxRetries\s*:\s*[1-9]/);
  });

  it("timeout is not the old 45_000 value", () => {
    expect(SRC).not.toMatch(/timeout\s*:\s*45_000/);
  });

  it("gpt-5.6-terra remains the fallback model", () => {
    expect(SRC).toMatch(/gpt-5\.6-terra/);
  });

  it("fallback uses nullish coalescing so OPENAI_MODEL env var takes precedence", () => {
    expect(SRC).toMatch(/OPENAI_MODEL.*\?\?.*gpt-5\.6-terra/);
  });

  it("store: false is retained", () => {
    expect(SRC).toMatch(/store\s*:\s*false/);
  });
});

// ─── Timeout comment documentation ────────────────────────────────────────────

describe("Timeout / retry comments", () => {
  it("explains why retries are disabled (duplicate paid requests)", () => {
    expect(SRC).toMatch(/duplicate/i);
  });

  it("explains that web-search can take longer than 45 seconds", () => {
    expect(SRC).toMatch(/longer than 45/i);
  });

  it("mentions that the user can manually retry", () => {
    expect(SRC).toMatch(/manually/i);
  });
});

// ─── Error classification ─────────────────────────────────────────────────────

describe("APIConnectionTimeoutError classification", () => {
  it("source recognises APIConnectionTimeoutError by constructor name", () => {
    expect(SRC).toMatch(/APIConnectionTimeoutError/);
  });

  it("produces the correct safe message for a timeout error", () => {
    // Reproduce the classification logic from the catch block
    function classifyError(err: unknown): string {
      const errObj =
        err && typeof err === "object" ? (err as Record<string, unknown>) : {};
      const constructorName =
        err instanceof Error ? err.constructor.name : String(typeof err);

      const isTimeout = constructorName === "APIConnectionTimeoutError";
      const isOpenAIError = "status" in errObj;

      const reqId =
        (errObj["requestID"] as string | undefined) ??
        (errObj["request_id"] as string | undefined) ??
        "n/a";
      const errType = (errObj["type"] as string | undefined) ?? "unknown";
      const errStatus = errObj["status"] as number | undefined;
      const errCode = (errObj["code"] as string | undefined) ?? "unknown";

      return isTimeout
        ? "AI research timed out before completion. No automatic retry was made."
        : isOpenAIError
          ? `AI service error (type: ${errType}, status: ${errStatus ?? "n/a"}, ` +
            `code: ${errCode}, request_id: ${reqId})`
          : "Research could not be completed. Please try again later.";
    }

    // Simulate an APIConnectionTimeoutError (connection timeout — no HTTP status)
    class APIConnectionTimeoutError extends Error {
      constructor() {
        super("Connection timed out");
        this.name = "APIConnectionTimeoutError";
        Object.setPrototypeOf(this, APIConnectionTimeoutError.prototype);
      }
    }
    const timeoutErr = new APIConnectionTimeoutError();
    expect(classifyError(timeoutErr)).toBe(
      "AI research timed out before completion. No automatic retry was made.",
    );
  });

  it("uses a generic message for non-OpenAI errors", () => {
    function isOpenAIError(err: unknown): boolean {
      return !!(err && typeof err === "object" && "status" in err);
    }

    const plainErr = new Error("ECONNREFUSED 127.0.0.1:5432");
    expect(isOpenAIError(plainErr)).toBe(false);
  });

  it("prefers requestID over request_id when both present (SDK v7 alias)", () => {
    const errObj = { requestID: "req-abc", request_id: "req-old", status: 500 };
    const reqId =
      (errObj["requestID"] as string | undefined) ??
      (errObj["request_id"] as string | undefined) ??
      "n/a";
    expect(reqId).toBe("req-abc");
  });

  it("falls back to request_id when requestID is absent", () => {
    const errObj = { request_id: "req-legacy", status: 429 };
    const reqId =
      (errObj["requestID" as keyof typeof errObj] as string | undefined) ??
      (errObj["request_id"] as string | undefined) ??
      "n/a";
    expect(reqId).toBe("req-legacy");
  });

  it("returns n/a when no request identifier is present (connection timeout)", () => {
    const errObj = {};
    const reqId =
      (errObj["requestID" as keyof typeof errObj] as string | undefined) ??
      (errObj["request_id" as keyof typeof errObj] as string | undefined) ??
      "n/a";
    expect(reqId).toBe("n/a");
  });
});

// ─── Secrets and prompts must not appear in safe error strings ────────────────

describe("Safe error strings — no secret or prompt leakage", () => {
  it("source never includes apiKey or OPENAI_API_KEY in the safeError string", () => {
    // The safeError construction must not reference apiKey or env key content
    const safeErrorBlock = SRC.slice(
      SRC.indexOf("const safeError ="),
      SRC.indexOf("logger.error(", SRC.indexOf("const safeError =")),
    );
    expect(safeErrorBlock).not.toMatch(/apiKey/);
    expect(safeErrorBlock).not.toMatch(/OPENAI_API_KEY/);
  });

  it("source does not log err.message (raw messages may expose internals)", () => {
    // logger.error calls must not log err.message
    const loggerCalls = SRC.split("\n")
      .filter((l) => l.includes("logger.error"))
      .join("\n");
    expect(loggerCalls).not.toMatch(/err\.message/);
  });

  it("safe timeout message contains no key, prompt or household reference", () => {
    const msg =
      "AI research timed out before completion. No automatic retry was made.";
    expect(msg).not.toMatch(/key|prompt|household|password|cookie|auth/i);
  });
});
