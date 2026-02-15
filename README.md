# Scenario Modeling & Sensitivity Analysis

FP&A scenario modeling: describe scenarios in plain English and get P&L impact in minutes.

## Quick start

### 1. Database (Docker)

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
cp ../.env.example .env   # optional: set OPENAI_API_KEY for LLM parsing
npm install
npm run db:migrate       # apply PostgreSQL schema
npm run dev
```

API: http://localhost:4000 — health: `GET /health`, parse: `POST /api/v1/scenarios` with `{ "nl_input": "..." }`.

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

App: http://localhost:3000 — chat UI; messages hit the backend to parse scenarios.

## Repo layout

- **frontend/** — Next.js chat UI (Claude cowork-style)
- **backend/** — Express API: NL parse, scenarios CRUD, DB
- **docker-compose.yml** — PostgreSQL for local dev
- **PRD.md** — product requirements
- **IMPLEMENTATION_PLAN.md** — phased implementation and tasks

## Env

- `backend/.env`: `DATABASE_URL`, optional `OPENAI_API_KEY`, `OPENAI_MODEL`, `PORT`, `FRONTEND_ORIGIN`
- `frontend`: optional `NEXT_PUBLIC_API_URL` (default `http://localhost:4000`)
