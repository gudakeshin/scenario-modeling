# Scenario Modeling & Sensitivity Analysis

AI-assisted FP&A tool: plain-English scenarios → mapped model levers → simulation → P&L impact, Monte Carlo, and audit trail.

## What is true today

- **Auth:** local JWT (register/login + refresh). Roles are `viewer` | `analyst` | `approver` | `admin`. There is no `x-user-id` header auth and no self-service role switch in the UI.
- **Documents:** Postgres keyword search over `document_chunks` (default). Optional OpenAI-compatible embeddings via `EMBEDDING_PROVIDER=openai`. Qdrant is **not** in the stack.
- **XLSX simulation:** formula-preserving ingest stores a sparse `workbook_snapshot` (exact formulas + cross-sheet links) separately from graph metadata; HyperFormula recalculates at simulation time. Chunks are search-only. Older workbooks need **re-upload** or `backend/scripts/reprocess-workbooks.ts`.
- **CSV uploads:** typed single-sheet `tabular_data` sources (no formulas / no multi-sheet links). They enrich context but do not replace an executable XLSX model.
- **Denomination:** Crore / Lakh (incl. Lac/Lacs) / Million / Billion / Thousand detected per source; amounts can be rescaled to a canonical Million unit via `toCanonical`. Mixed currencies without an explicit FX assumption are rejected. Display metadata (currency, unit, FX) is surfaced in ingestion reports.
- **LLM routing:** parse/reflection → `ANTHROPIC_MODEL_PARSE` (default Haiku); business analysis / context build → `ANTHROPIC_MODEL_ANALYSIS` (default `claude-sonnet-5`); QA / agentic reasoner → `ANTHROPIC_MODEL_QA` (default `claude-opus-4-8`).
- **Monte Carlo:** seeded PRNG (`mulberry32`), distributions (normal, lognormal, triangular, uniform, PERT), VaR/CVaR at 5%, optional data-derived fits + pairwise correlations.
- **Audit:** append-only hash chain (`prev_hash` / `row_hash`), DB trigger blocks UPDATE/DELETE, admin verify at `GET /api/v1/audit/verify`.
- **DEMO_MODE:** when true, enables demo seed mappings and relaxes identity-repair tie-out when source values are missing. Production identity repairs are evidence-gated (must reproduce stated values). Leave `DEMO_MODE` false in production. See [ADR 0004](docs/adr/0004-demo-mode.md).
- **Embeddings:** default `EMBEDDING_PROVIDER=none` (keyword only). Set `openai` + API URL/key for hybrid vector+keyword retrieval. Conversation memory available for Document Q&A.
- **Showcase agent:** set `SHOWCASE_AGENT_ENABLED=true`, or `DEPLOYMENT_PROFILE=showcase|enterprise`, after a validated executable model + merged business context; open-ended macro questions use a tool-using reasoning agent (human approve → run still required). Check `GET /api/v1/scenarios/agent-status`.
- **Sessions:** in-memory by default; set `REDIS_URL` for multi-instance session + scenario-context cache (Postgres dual-read fallback).
- **Auth providers:** `AUTH_PROVIDER=local` (default) or `oidc` with issuer/JWKS env vars; SSO login link appears when OIDC is enabled.
- **Object storage:** optional S3-compatible store (`OBJECT_STORAGE_*`); workbook bytes dual-write with Postgres BYTEA fallback / backfill script.
- **Portfolio UX:** `/dashboard` portfolio KPIs; scenario version history, actuals/budget/forecast lanes, live what-if preview (apply still requires approval).
- **Connectors:** SAP SAC (incl. audited write-back) and Anaplan (mock/read) behind `ENABLE_PLANNING_CONNECTORS`.
- **Errors:** pino + optional Sentry (`SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`) with PII scrubbing on backend and Next instrumentation.
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
  ├── Auth (local JWT or OIDC → local JWT)
  ├── NL parse / reflection / BA / QA / agent (Claude + optional prompt cache)
  ├── Optional Perplexity research
  ├── Simulation (compiled model DAG or XLSX HyperFormula)
  ├── Monte Carlo / sensitivity / attribution / goal-seek / driver tree
  ├── Documents (Postgres chunks + optional hybrid embeddings)
  ├── Sessions (memory or Redis) + portfolio / versions / actuals
  └── Audit hash chain → PostgreSQL (+ optional S3 artifacts)
```

## Key API surface

| Endpoint | Notes |
|----------|--------|
| `POST /api/v1/auth/register` | First user or admin-gated |
| `POST /api/v1/auth/login` | Access + refresh tokens |
| `GET /api/v1/auth/oidc/authorize` | SSO start when `AUTH_PROVIDER=oidc` |
| `POST /api/v1/scenarios` | Create from NL |
| `GET /api/v1/scenarios/agent-status` | Showcase agent readiness |
| `POST /api/v1/scenarios/:id/approve` | Human gate before run |
| `POST /api/v1/scenarios/:id/run` | Simulate |
| `GET /api/v1/portfolio/dashboard` | Workspace scenario library / KPIs |
| `POST /api/v1/documents/upload` | Upload / extract |
| `GET /api/v1/audit` | Trail (analyst+) |
| `GET /api/v1/audit/verify` | Hash-chain check (admin) |
| `GET /health` `/ready` `/metrics` | Ops probes |

## Showcase release checklist

1. Upload XLSX (+ optional strategy PDF) → fidelity validate → `validation_status=ready`
2. Open-ended agent question → review citations / preview P&L → Approve & Run
3. Multi-period analytics (tornado / two-way / MC / attribution / goal-seek / driver tree)
4. Export PPTX/Excel; confirm denomination + chart slides
5. `GET /api/v1/audit/verify` on the scenario
6. Golden P&L lock: `backend/src/tests/fixtures/golden_base_case_pl.json` (asserted by `goldenBaseCase.test.ts`)

## Tests & CI

```bash
cd backend && npm test          # unit / structural (no Anthropic required)
cd backend && npm run test:e2e  # needs migrated + seeded DB
cd backend && npm run test:all  # unit + e2e
cd frontend && npm run lint && npm test && npm run build
```

GitHub Actions: `.github/workflows/ci.yml` — Postgres + Redis, migrate, seed, `test:all`; frontend lint + build. No Anthropic key in CI.

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
