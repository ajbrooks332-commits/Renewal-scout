-- Migration 0008: create user_sessions table for connect-pg-simple
-- Idempotent: uses IF NOT EXISTS throughout so re-running is safe.

CREATE TABLE IF NOT EXISTS user_sessions (
  sid    varchar        PRIMARY KEY,
  sess   json           NOT NULL,
  expire timestamp(6)   NOT NULL
);

CREATE INDEX IF NOT EXISTS user_sessions_expire_idx
  ON user_sessions (expire);
