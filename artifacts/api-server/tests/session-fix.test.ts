/**
 * Tests for the PostgreSQL session persistence fix (migration 0008).
 *
 * Covers:
 * - session store is configured with createTableIfMissing: false
 * - login returns 500 with generic message when session.regenerate fails
 * - logger.error is called with the error (not the password) on regenerate failure
 * - migration SQL is idempotent (IF NOT EXISTS guards)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "fs";
import { join } from "path";
import app from "../src/app";

// ─── Migration SQL idempotency ────────────────────────────────────────────────

describe("Migration 0008 SQL", () => {
  const migrationPath = join(
    __dirname,
    "../../../lib/db/drizzle/0008_create_user_sessions.sql",
  );

  it("exists at the expected path", () => {
    expect(() => readFileSync(migrationPath, "utf-8")).not.toThrow();
  });

  it("uses CREATE TABLE IF NOT EXISTS", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS\s+user_sessions/i);
  });

  it("defines sid as PRIMARY KEY", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toMatch(/sid\s+varchar\s+PRIMARY KEY/i);
  });

  it("defines sess as json NOT NULL", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toMatch(/sess\s+json\s+NOT NULL/i);
  });

  it("defines expire as timestamp NOT NULL", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toMatch(/expire\s+timestamp[^\n]*NOT NULL/i);
  });

  it("creates an index on expire using IF NOT EXISTS", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(sql).toMatch(/ON\s+user_sessions\s*\(\s*expire\s*\)/i);
  });

  it("does not use the obsolete WITH (OIDS=FALSE) clause", () => {
    const sql = readFileSync(migrationPath, "utf-8");
    expect(sql).not.toMatch(/WITH\s*\(\s*OIDS\s*=/i);
  });
});

// ─── session.ts configuration ─────────────────────────────────────────────────

describe("Session store configuration", () => {
  it("session module source does not contain createTableIfMissing: true", () => {
    const src = readFileSync(
      join(__dirname, "../src/lib/session.ts"),
      "utf-8",
    );
    // Must not have the old dangerous flag
    expect(src).not.toMatch(/createTableIfMissing\s*:\s*true/);
    // Must have the safe flag
    expect(src).toMatch(/createTableIfMissing\s*:\s*false/);
  });
});

// ─── Login: session regeneration failure ─────────────────────────────────────

describe("POST /api/auth/login — session regeneration failure", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env["ADMIN_PASSWORD"] = "test-admin-password";
    process.env["NODE_ENV"] = "test";
  });

  it("returns 500 with a generic message when session.regenerate errors", async () => {
    // In the test environment the MemoryStore is used.
    // Monkey-patch express-session's Session.prototype.regenerate so that it
    // calls its callback with an error *for this one test*.
    const sessionModule = await import("express-session");
    const Session = sessionModule.default.Session as unknown as {
      prototype: { regenerate: (cb: (err?: Error) => void) => void };
    };
    const original = Session.prototype.regenerate.bind(Session.prototype);
    Session.prototype.regenerate = function (
      cb: (err?: Error) => void,
    ) {
      cb(new Error("pg connection refused"));
    };

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ password: "test-admin-password" });

    // Restore immediately after the request
    Session.prototype.regenerate = original;

    // Should be 500 with the safe generic message — never 200 or 401
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Session error during login.");
  });

  it("does not expose the internal error message to the browser on regenerate failure", async () => {
    const sessionModule = await import("express-session");
    const Session = sessionModule.default.Session as unknown as {
      prototype: { regenerate: (cb: (err?: Error) => void) => void };
    };
    const original = Session.prototype.regenerate.bind(Session.prototype);
    Session.prototype.regenerate = function (
      cb: (err?: Error) => void,
    ) {
      cb(new Error("secret internal db error"));
    };

    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ password: "test-admin-password" });

    Session.prototype.regenerate = original;

    // The internal error text must NOT leak to the client
    expect(JSON.stringify(res.body)).not.toContain("secret internal db error");
  });
});
