import type { RequestHandler } from "express";
import session from "express-session";

const secret = process.env["SESSION_SECRET"] ?? "dev-only-change-this";

export const sessionMiddleware: RequestHandler = session({
  secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000, // 12h
  },
});

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}
