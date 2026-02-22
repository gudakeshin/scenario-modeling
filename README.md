# Scenario Modeling & Sensitivity Analysis

An AI-powered FP&A tool that turns plain-English scenario descriptions into full P&L impact analysis in minutes. Powered by Claude (Anthropic), Qdrant vector search, and Perplexity web research.

## Features

- **Natural Language Scenarios** — describe scenarios like "What if recruitment costs go up by 10%?" and get instant P&L impact
- **Dynamic Context Engine** — upload financial documents (PDF/TXT), system auto-extracts company context, builds financial model with proper input/output variable classification
- **Multi-Agent Architecture:**
  - **Reflection Agent** — pre-parse "thinking" step visible to the user (like ChatGPT)
  - **Business Analysis Agent** — "So What?" layer with implications, risks, and actionable recommendations
  - **Quality Assurance Agent** — evaluates analysis quality across 6 dimensions, drives iterative refinement via QA-BA reflection loop
  - **Perplexity Search Agent** — real-time web research for macro/news/competitor scenarios
- **Multi-Period Simulation** — quarterly/monthly granularity with non-compounding percent deltas and absurdity validation
- **Sensitivity & Monte Carlo** — tornado charts, P10/P50/P90 confidence intervals
- **Scenario Comparison** — side-by-side with user-friendly labels, sorting, filtering
- **Document RAG** — upload documents, chat with them via Qdrant vector search
- **Full Audit Trail** — immutable logging, SOX-ready, CSV/JSON export
- **Role-Based Access** — viewer, analyst, approver, admin with self-service role switching
- **Export** — Excel, CSV, PowerPoint (Deloitte-branded)
- **Dynamic Currency** — auto-detects INR, USD, EUR etc. from uploaded documents

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Frontend | Next.js 14, React, TypeScript, Tailwind CSS, Recharts |
| Backend | Node.js, Express, TypeScript |
| LLM | Anthropic Claude Haiku 4.5 |
| Web Search | Perplexity Sonar API |
| Vector DB | Qdrant Cloud |
| Database | PostgreSQL |
| Export | ExcelJS, PptxGenJS |

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL (or Docker)
- Qdrant Cloud account (for document features)
- Anthropic API key (for AI features)

### 1. Database

```bash
docker compose up -d
```

### 2. Backend

```bash
cd backend
cp .env.example .env
# Edit .env with your API keys:
#   ANTHROPIC_API_KEY=your-key
#   QDRANT_URL=your-qdrant-url
#   QDRANT_API_KEY=your-qdrant-key
#   PERPLEXITY_API_KEY=your-perplexity-key (optional)
npm install
npm run db:migrate
npm run dev
```

API runs at http://localhost:4000

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

App runs at http://localhost:3000

## Architecture

```
Frontend (Next.js) → API Gateway (Express)
    ├── Reflection Agent (Claude)
    ├── NL Parser (Claude)
    ├── Perplexity Search Agent
    ├── Simulation Engine (multi-period)
    ├── Business Analysis Agent (Claude) ←→ QA Agent (Claude)
    │   └── Iterative reflection loop (up to 3 rounds)
    ├── Context Engine (Qdrant + Claude)
    │   └── Document-driven model building
    └── Data Layer
        ├── PostgreSQL (scenarios, params, audit, users, models, context)
        └── Qdrant Cloud (document vectors)
```

## How It Works

1. **Upload Documents** — upload your P&L or annual report; the Context Engine extracts financial metrics and builds a model
2. **Ask a Question** — type a scenario in plain English
3. **AI Thinks** — reflection agent reasons through the scenario; Perplexity fetches real-time data if needed
4. **Parameters Extracted** — Claude maps your scenario to model variables (input-only, never calculated fields)
5. **Review & Approve** — review parameters, modify values, approve to run
6. **Simulation** — multi-period P&L computed with absurdity validation
7. **Business Analysis** — "So What?" agent produces insights; QA agent validates quality
8. **QA-BA Loop** — if QA fails, BA regenerates with QA feedback (visible to user)
9. **Export & Share** — Excel, CSV, PPTX export; share with team members

## Repo Layout

```
frontend/               Next.js chat UI (Deloitte-themed)
├── src/components/     ChatWindow, BusinessInsights, ComparisonView, DocumentManager, etc.
├── src/lib/            API client, metrics utilities, currency formatting
backend/                Express API
├── src/routes/         scenarios, context, documents, users
├── src/services/       parser, simulationService, businessAnalysisAgent, qaAgent,
│                       contextEngine, qdrantService, ragService, reflectionService,
│                       searchService, monteCarloService, sensitivityService, etc.
├── src/models/         registry (dynamic model definitions)
├── src/db/             PostgreSQL schema and connection
sample_data/            Sample financial documents for testing
PRD.md                  Product requirements document
IMPLEMENTATION_PLAN.md  Phased implementation plan with task tracking
docker-compose.yml      PostgreSQL for local dev
```

## Environment Variables

Key variables in `backend/.env`:

```
DATABASE_URL=postgresql://user:pass@localhost:5432/scenario_modeling
ANTHROPIC_API_KEY=sk-ant-...        # Required for AI features
QDRANT_URL=https://...qdrant.io     # Required for document features
QDRANT_API_KEY=...                  # Required for document features
PERPLEXITY_API_KEY=pplx-...         # Optional: real-time web search
PORT=4000
FRONTEND_ORIGIN=http://localhost:3000
```

## Key API Endpoints

| Endpoint | Description |
|----------|------------|
| `POST /api/v1/scenarios` | Create scenario from natural language |
| `POST /api/v1/scenarios/:id/approve` | Approve parameters for simulation |
| `POST /api/v1/scenarios/:id/run` | Run simulation |
| `POST /api/v1/scenarios/:id/business-analysis` | Generate business analysis + QA loop |
| `POST /api/v1/scenarios/compare` | Compare multiple scenarios |
| `POST /api/v1/context/build` | Build model from uploaded documents |
| `POST /api/v1/documents/upload` | Upload document for RAG |
| `POST /api/v1/documents/:id/query` | Chat with a document |
| `GET /api/v1/scenarios/:id/export/excel` | Export to Excel |
| `GET /api/v1/scenarios/:id/export/pptx` | Export to PowerPoint |

## License

Private — Deloitte internal use.
