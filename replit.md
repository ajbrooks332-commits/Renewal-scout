# Renewal Scout

A private password-protected UK household renewal dashboard. Tracks broadband, energy, insurance, credit cards, loans, and similar services. Runs AI-powered web research via OpenAI to compare current public deals and emails comparison reports. Deliberately stops before submitting forms, applying for credit, or making payments.

## Run & Operate

- `pnpm --filter @workspace/renewal-scout run dev` — run the frontend (port from env)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string (auto-provisioned by Replit)

## Required Secrets

| Secret | Purpose |
|---|---|
| `OPENAI_API_KEY` | AI deal research with web search |
| `ADMIN_PASSWORD` | Dashboard login password |
| `SESSION_SECRET` | Cookie signing (already set) |

Optional email alert secrets: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `ALERT_EMAIL`

Optional scheduler settings: `SCHEDULER_ENABLED` (default true), `SCHEDULER_HOUR` (default 7), `SCHEDULER_MINUTE` (default 30), `APP_TIMEZONE` (default Europe/London)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React 19 + Vite + Tailwind CSS (British slate-and-teal palette)
- API: Express 5 + express-session (cookie-based auth)
- DB: PostgreSQL + Drizzle ORM
- AI research: OpenAI `gpt-4o` with `web_search_preview` tool
- Validation: Zod (zod/v4), drizzle-zod
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where Things Live

- `lib/api-spec/openapi.yaml` — API contract (source of truth)
- `lib/db/src/schema/services.ts` — services table schema
- `lib/db/src/schema/research-runs.ts` — research_runs table schema
- `artifacts/api-server/src/lib/research-service.ts` — AI research logic
- `artifacts/api-server/src/lib/renewal-logic.ts` — date/urgency calculations
- `artifacts/api-server/src/lib/scheduler.ts` — daily due-check scheduler
- `artifacts/api-server/src/routes/` — auth, services, research, dashboard routes
- `artifacts/renewal-scout/src/pages/` — Login, Dashboard, ServiceDetail, ServiceForm

## Architecture Decisions

- Password-only auth via express-session (no username — single-user personal tool)
- OpenAI Responses API with `web_search_preview` tool for real-time deal research
- Structured JSON output via json_schema format for typed DealReport
- Scheduler implemented as a setTimeout-based loop (single-process safe, no cron daemon needed)
- All integer fields in OpenAPI spec use `type: number` (not `type: integer`) because Orval + Zod v3 generates `zod.int()` for `integer` which doesn't exist in v3

## Product

Renewal Scout watches your household service renewal dates, researches current publicly available deals using an AI agent with web search, and prepares a structured comparison report with up to 3 alternatives, costs, headline terms, exclusions, source URLs, a recommended next step, and an application pack checklist. It never submits forms, applies for credit, cancels services, or makes payments.

## User Preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Custom fetch (`lib/api-client-react/src/custom-fetch.ts`) must include `credentials: "include"` for session cookies to be sent cross-origin
- All `type: integer` in OpenAPI spec must stay as `type: number` — Orval generates `zod.int()` for integer which breaks Zod v3 typecheck
- The scheduler fires on first app import (in `app.ts`), not separately. For production with multiple workers, set `SCHEDULER_ENABLED=false` and use a separate scheduled deployment
- Research runs fire-and-forget in background. Frontend should poll or ask user to refresh after triggering

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
