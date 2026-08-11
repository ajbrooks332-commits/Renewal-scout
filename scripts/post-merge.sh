#!/bin/bash
set -e
# Install dependencies only.
# Database migrations are applied automatically at startup via runMigrations()
# in artifacts/api-server/src/index.ts — do not use drizzle-kit push here.
pnpm install --frozen-lockfile
