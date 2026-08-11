import type { RequestHandler } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";

const isProduction = process.env["NODE_ENV"] === "production";
const rawSecret = process.env["SESSION_SECRET"];

// Validate SESSION_SECRET at module load time so server cannot start with bad config
if (isProduction) {
  if (!rawSecret || rawSecret.length < 32) {
    console.error(
      "FATAL: SESSION_SECRET must be set and at least 32 characters in production. Server will not start.",
    );
    process.exit(1);
  }
} else {
  if (!rawSecret || rawSecret === "dev-only-change-this") {
    console.warn(
      "WARNING: SESSION_SECRET is not set or is using the default. Set it before going to production.",
    );
  }
}

const secret = rawSecret ?? "dev-only-change-this";

const PgSession = connectPgSimple(session);

// In the test environment the PG pool is mocked and cannot persist sessions.
// Use an in-memory store so that login → cookie → protected-route flows work.
const store =
  process.env["NODE_ENV"] === "test"
    ? new session.MemoryStore()
    : new PgSession({
        pool,
        // createTableIfMissing is false: migration 0008 owns the table.
        // connect-pg-simple's bundled DDL uses WITH (OIDS=FALSE) which is
        // rejected by modern PostgreSQL; the migration avoids that clause.
        createTableIfMissing: false,
        tableName: "user_sessions",
      });

export const sessionMiddleware: RequestHandler = session({
  store,
  secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
});

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}
