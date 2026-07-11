# Scenario Modeling & Sensitivity Analysis

AI-assisted FP&A tool: plain-English scenarios → mapped model levers → simulation → P&L impact, Monte Carlo, and audit trail.

## What is true today

- **Auth:** local JWT (register/login + refresh). Roles are `viewer` | `analyst` | `approver` | `admin`. There is no `x-user-id` header auth and no self-service role switch in the UI.
- **Documents:** Postgres keyword search over `document_chunks` (default). Optional OpenAI-compatible embeddings via `EMBEDDING_PROVIDER=openai`. Qdrant is **not** in the stack.
- **XLSX simulation:** real cell-level propagation with HyperFormula from a workbook graph captured at upload. Older workbooks uploaded before structural extraction need **re-upload** or `backend/scripts/reprocess-workbooks.ts`.
- **Monte Carlo:** seeded PRNG (`mulberry32`), distributions (normal, lognormal, triangular, uniform, PERT), VaR/CVaR at 5%.
- **Audit:** append-only hash chain (`prev_hash` / `row_hash`), DB trigger blocks UPDATE/DELETE, admin verify at `GET /api/v1/audit/verify`.
- **DEMO_MODE:** when true, enables the hardcoded P&L formula repair map and (via `npm run db:seed`) demo `model_mappings`. Leave false in production. See [ADR 0004](docs/adr/0004-demo-mode.md).
- **Embeddings:** default `EMBEDDING_PROVIDER=none` (keyword only). Set `openai` + API URL/key for vectors.
- **Errors:** `captureException` logs via pino (`backend/src/errorReporter.ts`); optional `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` reserved for future Sentry (SDK not required yet).

Schema source of truth is `backend/migrations/` (node-pg-migrate). `backend/src/db/schema.sql` is a legacy snapshot kept for reference; prefer migrations.

## Tech stack

| Layer | Stack |
|-------|--------|
| Frontend | Next.js 14, React, TypeScript, Tailwind, Recharts |
| Backend | Node 20, Express, TypeScript |
| LLM | Anthropic Claude (optional locally; required in production) |
| Web research | Perplexity Sonar (optional) |
| Docs parse | LlamaParse / LlamaCloud (optional) |
| DB | PostgreSQL 16 |
| Spreadsheet runtime | HyperFormula |
| Metrics | Prometheus (`/metrics`) |

## Quick start (local)

### Prerequisites

- Node.js 20+
- PostgreSQL (or Docker Compose)
- Anthropic API key for full AI paths (heuristic fallbacks exist without it)

### 1. Database

```bash
docker compose up -d postgres
```

Host port is **5433** → container 5432. For a local Postgres on 5432, point `DATABASE_URL` accordingly.

### 2. Backend

```bash
cd backend
cp .env.example .env
# Set JWT_SECRET (≥32 chars) and optionally ANTHROPIC_API_KEY
npm ci
npm run db:migrate
npm run db:seed   # creates seed admin — see scripts/seed-dev.ts
npm run dev
```

API: http://localhost:4000  

Env reference: **`backend/.env.example`** (root `.env.example` only points here).

### 3. Frontend

```bash
cd frontend
npm ci
# optional: export NEXT_PUBLIC_API_URL=http://localhost:4000
npm run dev
```

App: http://localhost:3000 — register/login against the API.

## Docker Compose (postgres + api + web)

```bash
export JWT_SECRET="$(openssl rand -base64 48)"
export ANTHROPIC_API_KEY="sk-ant-..."
docker compose up --build
```

- **postgres** — healthchecked
- **backend** — builds image, migrates on start, `/ready` healthcheck, port 4000
- **frontend** — Next standalone, `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`), port 3000

`JWT_SECRET` and `ANTHROPIC_API_KEY` are required by Compose. Qdrant is not started.

## Architecture (simplified)

```
Browser (Next.js) → Express API
  ├── Auth (local JWT)
  ├── NL parse / reflection / BA / QA (Claude)
  ├── Optional Perplexity research
  ├── Simulation (compiled model DAG or XLSX HyperFormula)
  ├── Monte Carlo / sensitivity
  ├── Documents (Postgres chunks + keyword search)
  └── Audit hash chain → PostgreSQL
```

## Key API surface

| Endpoint | Notes |
|----------|--------|
| `POST /api/v1/auth/register` | First user or admin-gated |
| `POST /api/v1/auth/login` | Access + refresh tokens |
| `POST /api/v1/scenarios` | Create from NL |
| `POST /api/v1/scenarios/:id/approve` | Human gate before run |
| `POST /api/v1/scenarios/:id/run` | Simulate |
| `POST /api/v1/documents/upload` | Upload / extract |
| `GET /api/v1/audit` | Trail (analyst+) |
| `GET /api/v1/audit/verify` | Hash-chain check (admin) |
| `GET /health` `/ready` `/metrics` | Ops probes |

## Tests & CI

```bash
cd backend && npm test          # unit / structural (no Anthropic required)
cd backend && npm run test:e2e  # needs migrated + seeded DB
cd frontend && npm run lint && npm run build
```

GitHub Actions: `.github/workflows/ci.yml` — backend (Postgres service + migrate + test) and frontend (lint + build). No Anthropic key in CI.

## Repo layout

```
frontend/          Next.js UI
backend/           Express API, migrations/, Docker
docs/adr/          Architecture decision records
sample_data/       Sample financial inputs
docker-compose.yml Postgres + backend + frontend
SECURITY.md        Auth, secrets, audit verify runbook
PRD.md             Product requirements
```

## License

Private — Deloitte internal use.
