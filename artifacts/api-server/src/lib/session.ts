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

export const sessionMiddleware: RequestHandler = session({
  store: new PgSession({
    pool,
    createTableIfMissing: true,
    tableName: "user_sessions",
  }),
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
