# UC 07 — Scenario Modeling & Sensitivity Analysis

## Product Requirements Document (PRD)

**Status:** Engineering-Ready Spec — Active Development
**Owner:** FP&A Product Team
**Last Updated:** February 22, 2026
**Stack:** Next.js (frontend), Node.js/Express (backend), PostgreSQL, Qdrant (vector DB), Anthropic Claude (LLM), Perplexity (web search)

---

## 1. Problem Statement

FP&A teams are asked to model 5–10 strategic scenarios per quarter, but each scenario takes 2–4 hours to build manually in spreadsheets — translating business assumptions into model parameters, updating formulas, running calculations, and formatting outputs.

This means executives either wait days for scenario analysis or make decisions with fewer scenarios than they need. The manual process is also error-prone: a mislinked cell or forgotten assumption can silently corrupt results.

Additionally, analysts often need to reference internal documents (reports, strategy decks, market analyses) to inform their scenario assumptions, but extracting and synthesizing this data manually is time-consuming and inconsistent.

**Who experiences this:** FP&A analysts (build scenarios), finance directors (review), CFOs and executives (consume and decide), board members (evaluate strategic trade-offs).

**Cost of not solving:** Slower strategic decisions, fewer scenarios evaluated per decision, ~30% of manually-built scenarios contain errors, FP&A team spends 60%+ time on mechanical work instead of strategic analysis.

**Key metrics today:**

| Metric | Current State |
|--------|--------------|
| Time per scenario build | 2–4 hours |
| Scenarios with errors | ~30% |
| Exec wait time for analysis | 3–5 days |
| Scenarios evaluated per quarter | 5–10 |
| Time spent referencing documents | 30–60 min per scenario |

---

## 2. Goals

| # | Goal | Measurement |
|---|------|-------------|
| G1 | Reduce scenario build time from 2–4 hours to < 5 minutes | Median time from NL input to output render |
| G2 | Enable executives to self-serve scenario requests without requiring FP&A as intermediary | % of scenarios initiated by non-FP&A users |
| G3 | Eliminate manual formula errors by using validated, version-controlled model logic | Error rate in scenario outputs vs. pre-agent baseline |
| G4 | Increase scenario throughput from 5–10 to 20+ per quarter | Total completed scenarios per quarter |
| G5 | Provide full audit trail of assumptions, model version, and outputs | 100% of runs have complete lineage records |
| G6 | Enable analysts to query internal documents via AI to inform scenario assumptions | Time from document upload to insight extraction |
| G7 | Incorporate real-time macroeconomic and competitive intelligence into scenario analysis | % of scenarios enriched with external data |

---

## 3. Non-Goals (V1)

| # | Non-Goal | Rationale |
|---|----------|-----------|
| NG1 | Replacing the financial model itself | The agent operates on top of existing models; it does not replace Anaplan, Adaptive, or spreadsheet models |
| NG2 | ~~Real-time market data integration~~ **PARTIALLY ADDRESSED** | Perplexity search now provides real-time macro/news research for scenarios; full structured data feeds remain P2 |
| NG3 | Automated scenario execution without human review | All outputs require FP&A sign-off before sharing with stakeholders |
| NG4 | ~~Multi-year strategic planning horizons~~ **ADDRESSED** | Multi-period simulation now supports monthly/quarterly granularity with configurable horizons |
| NG5 | Custom model builder / formula editor | Users cannot define new model logic via the agent; model definitions are managed separately |

---

## 4. User Stories

### 4.1 CFO

**US-01:** As a CFO, I want to describe a scenario in plain English ("What if we delay the APAC launch by one quarter and raw materials increase 8%?") and see P&L impact within minutes, so I can evaluate strategic options in real time during executive meetings.

**Acceptance Criteria:**
- Given a natural language input
- When submitted
- Then the system extracts parameters (geography=APAC, timeline_shift=+1Q, raw_material_delta=+8%), maps them to model variables, runs simulation, and returns comparative P&L within 5 minutes
- And if any parameter cannot be parsed with confidence > 0.8, the system prompts for clarification before proceeding
- And the system shows visible "thinking" / reflection before parsing to build user trust

**Implementation Status:** ✅ Complete — LLM-powered parser with reflection loop, interactive follow-up questions for disambiguation, heuristic fallback.

**US-02:** As a CFO, I want side-by-side comparison of base case vs. 2–3 scenarios with clear assumption differences highlighted, so I can present trade-offs to the board without ambiguity.

**Acceptance Criteria:**
- Given 2+ completed scenarios
- When comparison view is selected
- Then output shows base vs. scenarios with delta columns (absolute and %), assumption diff table, and key metric callouts (Revenue, EBITDA, Net Income, Operating Cash Flow)
- And output is exportable to Excel, CSV, and PowerPoint in Deloitte-branded template format

**Implementation Status:** ✅ Complete — Comparison view with sorting/filtering, export to Excel/CSV/PPTX with Deloitte branding, authenticated downloads.

---

### 4.2 FP&A Analyst

**US-03:** As an FP&A analyst, I want the agent to auto-map natural language parameters to our financial model variables, so I don't spend time manually translating business assumptions into model inputs.

**Acceptance Criteria:**
- Given a scenario description with business terms
- When parsed
- Then each term maps to a specific model variable with confidence score > 0.8
- And if confidence < 0.8, the system prompts for clarification with suggested matches
- And mapping supports synonyms and abbreviations ("raw mats" = raw_material_cost)
- And the LLM provides its reasoning ("thinking") visible to the user

**Implementation Status:** ✅ Complete — Claude-powered parser with `suggested_variable_id`, reflection loop, dynamic model description injection.

**US-04:** As an FP&A analyst, I want to review and override any auto-mapped parameter before the simulation runs, so I maintain control over model inputs and catch misinterpretations.

**Acceptance Criteria:**
- Given auto-mapped parameters
- When displayed for review
- Then each parameter shows: extracted value, mapped model variable, current base value, and proposed override
- And analyst can accept, modify, or reject each parameter individually
- And rejected parameters are excluded from simulation; system recalculates with remaining
- And simulation cannot run without explicit "Approve & Run" action

**Implementation Status:** ✅ Complete — ParameterReview panel with accept/reject/modify per parameter, Approve & Run gate.

**US-10 (NEW):** As an FP&A analyst, I want to upload internal documents (financial reports, strategy decks, market analyses) and ask questions about them using AI, so I can quickly extract insights to inform my scenario assumptions.

**Acceptance Criteria:**
- Given a PDF, TXT, MD, or CSV document
- When uploaded
- Then the system extracts text, chunks it, generates vector embeddings, and stores them in Qdrant
- And I can ask natural language questions about the document
- And the system retrieves relevant passages via vector search and generates grounded answers with source citations
- And I can query across all uploaded documents or a specific one

**Implementation Status:** ✅ Complete — Document upload (PDF/TXT/MD/CSV), Qdrant vector storage, RAG pipeline with Claude, source citations with relevance scores.

**US-11 (NEW):** As an FP&A analyst, I want the system to use real-time web research when I describe a macroeconomic scenario or competitor action, so the parameters are grounded in current data rather than my guesses.

**Acceptance Criteria:**
- Given a scenario like "What if the Fed raises rates by 50 basis points?" or "What if our competitor launches a price war?"
- When parsed
- Then the system detects the need for external research
- And triggers Perplexity web search to gather current data points
- And uses the research context to extract more precise parameters
- And shows the research summary and sources in the chat

**Implementation Status:** ✅ Complete — Perplexity Sonar integration, automatic detection of macro/news/competitor queries, research context displayed with data points and sources.

---

### 4.3 Board Member

**US-05:** As a board member, I want scenario comparison outputs with clearly documented assumptions and sensitivity ranges, so I can assess risk without relying on verbal explanations from the finance team.

**Acceptance Criteria:**
- Given a scenario comparison output
- When viewed
- Then each scenario includes: named assumption list with values, sensitivity range for top 5 variables, and a one-paragraph narrative summary auto-generated from the data
- And all content is clearly labeled as "AI-generated draft — review required" where applicable
- And a "So What?" business analysis provides actionable recommendations, risk assessment, and decision framework

**Implementation Status:** ✅ Complete — Narrative generation, business analysis agent with headline/implications/risks/recommendations, tornado charts for sensitivity, Monte Carlo for confidence intervals.

---

### 4.4 FP&A Manager

**US-06:** As an FP&A manager, I want to save scenario configurations as reusable templates (e.g., "recession playbook", "aggressive growth"), so we can quickly re-run standard scenarios each quarter without rebuilding them.

**Acceptance Criteria:**
- Given a completed scenario
- When "Save as Template" is selected
- Then the scenario parameters, model version reference, and output format are saved
- And template can be loaded, parameters adjusted, and re-run
- And templates are versioned; can be cloned and modified
- And org-wide sharing with permissions is supported

**Implementation Status:** ✅ Complete — Template gallery with save/clone/version, sharing scopes (private/team/org).

**US-07:** As an FP&A manager, I want full audit trail showing who created a scenario, what parameters were used, which model version ran, and what outputs were generated, so I can reproduce any historical analysis.

**Acceptance Criteria:**
- Given any historical scenario run
- When audit trail is viewed
- Then display: creator, timestamp, NL input, extracted parameters, model version hash, parameter overrides, and link to output
- And data is retained for 3+ years (configurable)
- And audit log is exportable as CSV/JSON for SOX documentation

**Implementation Status:** ✅ Complete — AuditTrailViewer with filtering, full lifecycle logging, CSV export.

---

### 4.5 Data / Platform Engineering

**US-08:** As a data engineer, I want the scenario engine to consume model definitions via a versioned API (not embedded logic), so model updates don't require agent code changes.

**Acceptance Criteria:**
- Given a model definition update
- When deployed to the model registry
- Then the scenario agent uses the new version for subsequent runs without code deployment
- And old versions remain accessible for historical re-runs
- And model version is locked per simulation (immutable snapshot)

**Implementation Status:** ✅ Complete — Dynamic model definition with tags, centralized `computeBaseCase()`, `describeModelForLLM()`.

**US-09:** As a platform engineer, I want scenario simulations to complete within resource guardrails (max 60s compute, bounded memory), so one user's complex scenario doesn't degrade the system for others.

**Acceptance Criteria:**
- Given a scenario simulation request
- When compute exceeds 60s or memory exceeds threshold
- Then the job is terminated with a clear error message and suggestion to simplify parameters
- And resource usage is logged per run for capacity planning

**Implementation Status:** ✅ Complete — Compute timeout enforcement, rate limiting, input validation.

---

## 5. Requirements

### 5.1 Must-Have (P0) — All Complete ✅

#### P0-01: Natural Language Scenario Parser
Accept free-text scenario descriptions and extract structured parameters (variables, values, time horizons, geographies).

**Acceptance Criteria:**
- [x] Supports compound scenarios with 2+ simultaneous variable changes
- [x] Extracts: variable name, direction, magnitude, scope (BU/geo/product), time range
- [x] Returns confidence score per parameter; prompts user if any score < 0.8
- [x] Handles relative ("increase 8%") and absolute ("set to $50M") inputs
- [x] Rejects nonsensical inputs with clear error ("Cannot parse: please rephrase")
- [x] Latency: parameter extraction completes in < 5 seconds

**Technical Implementation:** Claude Haiku 4.5 (Anthropic) with structured JSON output, LLM reflection loop for pre-parse reasoning, heuristic fallback parser when LLM unavailable. Perplexity Sonar integration for real-time research on macro/news/competitor scenarios. Interactive follow-up questions for disambiguation.

---

#### P0-02: Parameter-to-Model Variable Mapping
Map extracted NL parameters to specific variables in the registered financial model.

**Acceptance Criteria:**
- [x] Maintains a mapping registry: business terms → model variable IDs
- [x] Supports synonyms and abbreviations ("raw mats" = `raw_material_cost`)
- [x] Displays mapped variables for human review before simulation executes
- [x] Handles unmapped terms gracefully: surfaces to user with suggested matches
- [x] Mapping registry is editable by FP&A admins (add/remove/rename)
- [x] Registry supports bulk import/export (CSV format)

**Technical Implementation:** PostgreSQL `model_mappings` table with synonym arrays, LLM-powered `suggested_variable_id` during parsing, dynamic model description via `describeModelForLLM()`.

---

#### P0-03: Financial Model Simulation Engine
Execute scenario parameters against the registered financial model and produce P&L outputs.

**Acceptance Criteria:**
- [x] Computes full P&L with line-item detail through EBITDA and net income
- [x] Produces cash flow impact (operating, investing, financing)
- [x] Runs within 60 seconds for standard models (< 500 variables)
- [x] Supports 1–4 quarter forward horizon with monthly granularity
- [x] Model version is locked per simulation (immutable snapshot)
- [x] Handles edge cases: division by zero, negative values where not expected

**Technical Implementation:** Driver-based simulation engine with multi-period support (monthly/quarterly), non-compounding percent deltas (each period applies same change to original base), post-simulation absurdity validation (flags >200% metric changes), compute timeout enforcement.

---

#### P0-04: Side-by-Side Scenario Comparison
Present base case vs. 1–3 scenarios with delta analysis, assumption diffs, and key metric highlights.

**Acceptance Criteria:**
- [x] Comparison table: base vs. up to 3 scenarios, with absolute and % delta columns
- [x] Assumption diff table showing which parameters differ across scenarios
- [x] Key metric callout cards: Revenue, EBITDA, Net Income, Operating Cash Flow
- [x] Export to Excel (.xlsx), CSV, and PowerPoint (.pptx) in Deloitte-branded format
- [x] Sorting: by delta magnitude, by line item, by custom order
- [x] Scenario selector shows descriptions and dates (not UUIDs)
- [x] Auto-generated scenario names from input text

---

#### P0-05: Human Review & Override Gate
Require explicit human approval of mapped parameters before simulation runs; allow override of any parameter.

**Acceptance Criteria:**
- [x] Pre-simulation review screen shows all parameters with current base values and proposed changes
- [x] User can accept, modify value, or reject each parameter individually
- [x] Rejected parameters are excluded from simulation; system recalculates with remaining
- [x] Override history is logged in audit trail (who changed what, when)
- [x] Simulation cannot run without explicit "Approve & Run" action
- [x] Review screen shows parameter confidence scores to guide attention

---

#### P0-06: Audit Trail & Reproducibility
Log every scenario run with full lineage: NL input, parsed parameters, model version, overrides, outputs, reviewer.

**Acceptance Criteria:**
- [x] Each run assigned unique `scenario_id` with immutable record
- [x] Stores: raw NL text, extracted params, model version hash, human overrides, output snapshot
- [x] Any historical scenario can be re-loaded and re-run with same or updated model
- [x] Audit records retained for minimum 3 years (configurable)
- [x] Export audit log as CSV/JSON for SOX documentation
- [x] Search and filter audit records by date, user, model version, parameter

---

#### P0-07: Auto-Generated Narrative Summary
Produce a 2–3 paragraph executive summary describing scenario assumptions, key impacts, and notable risks.

**Acceptance Criteria:**
- [x] Summary includes: scenario description, top 3 P&L impacts by magnitude, cash flow implications
- [x] Language is professional, finance-appropriate, and avoids jargon not in the parameter set
- [x] Clearly labels content as "AI-generated draft — review required"
- [x] Supports export as standalone paragraph block for insertion into board decks
- [x] Narrative adjusts tone/detail based on audience setting (board vs. internal)

**Technical Implementation:** Claude-powered narrative generation with audience-aware prompting.

---

#### P0-08: Role-Based Access Control
Control who can create, view, approve, and share scenarios based on organizational role.

**Acceptance Criteria:**
- [x] Roles: Viewer (read-only), Analyst (create + run), Approver (approve for sharing), Admin (manage models + mappings)
- [x] Scenario outputs are private to creator until explicitly shared or approved
- [x] Sharing requires Approver-level permission
- [x] All access events logged for compliance
- [x] Role assignments manageable by org Admin via settings UI

**Technical Implementation:** RBAC middleware with `x-user-id` header, `requireRole()` guard, RoleManagement and SharingPanel UI components.

---

### 5.2 Nice-to-Have (P1) — All Complete ✅

#### P1-01: Monte Carlo Simulation
Run 1,000+ iterations with probabilistic distributions on key inputs; output confidence intervals and probability-weighted outcomes.

**Acceptance Criteria:**
- [x] User selects variables for stochastic treatment
- [x] Defines distribution per variable: normal, triangular, uniform (with parameters)
- [x] Output shows P10/P50/P90 ranges for key metrics
- [x] Visualization: fan chart or probability distribution histogram
- [x] Compute completes within 120 seconds for 1,000 iterations

**Implementation Status:** ✅ Complete — MonteCarloView with configurable distributions, 100–10,000 iterations, P10/P50/P90/mean/stddev output.

---

#### P1-02: Sensitivity Tornado Charts
Auto-generate tornado chart showing which variables have the largest impact on a selected output metric (e.g., EBITDA).

**Acceptance Criteria:**
- [x] Top 10 variables ranked by impact magnitude
- [x] Each bar shows +/- one standard deviation effect on selected metric
- [x] Correct sign handling (cost variables: decrease → positive impact)
- [x] Exportable as image (PNG) and PowerPoint chart object

**Implementation Status:** ✅ Complete — TornadoChart with proper downside/upside rendering, maxDelta scaling, spread display.

---

#### P1-03: Scenario Template Library
Save and share reusable scenario templates.

**Acceptance Criteria:**
- [x] Templates store: parameter set, default values, model version reference, output format
- [x] Templates are versioned; can be cloned and modified
- [x] Org-wide sharing with permissions (private, team, org-wide)
- [x] Template gallery UI with search and categorization

**Implementation Status:** ✅ Complete — TemplateGallery with save/clone/version, sharing scopes.

---

#### P1-04: Conversational Follow-Up
After initial results, allow follow-up NL queries that layer on additional parameters.

**Acceptance Criteria:**
- [x] System maintains session context across follow-up queries
- [x] New parameters are additive to existing scenario
- [x] User can see cumulative parameter list at any point
- [x] "Reset" option to start fresh (new chat)
- [x] Session context expires after 24 hours of inactivity

**Implementation Status:** ✅ Complete — In-memory session management with 24h TTL, additive parameter updates, dynamic placeholder text.

---

### 5.3 Extended Features (P1+) — Implemented

#### P1-05: Business Analysis Agent ("So What?" Layer)
LLM-powered agent that analyzes scenario results and provides actionable business insights.

**Acceptance Criteria:**
- [x] Headline summarizing the "so what" for the business
- [x] Business implications with severity ratings (positive/negative/neutral)
- [x] Risk assessment with likelihood and mitigation strategies
- [x] Actionable recommendations with priority (immediate/short-term/monitor) and owner
- [x] Decision framework context
- [x] Confidence note on analysis quality

**Implementation Status:** ✅ Complete — Auto-triggered after simulation, QA-BA reflection loop with up to 3 iterations, per-period P&L analysis (not aggregate), displayed in BusinessInsights panel with visible reflection log.

---

#### P1-06: Perplexity Web Search Integration
Real-time web-grounded research for macroeconomic scenarios, news impacts, and competitor actions.

**Acceptance Criteria:**
- [x] Automatic detection of macro/news/competitor queries
- [x] Perplexity Sonar API integration for real-time search
- [x] Research context (summary, data points, sources) injected into LLM parser
- [x] Results displayed to user with source citations
- [x] Graceful degradation when API key not configured

**Implementation Status:** ✅ Complete — `searchService.ts` with auto-detection, enriched parsing, user-visible notices.

---

#### P1-07: Interactive Follow-Up Questions & Scenario Refinement
Structured disambiguation when scenario input is ambiguous.

**Acceptance Criteria:**
- [x] LLM generates specific follow-up questions with selectable options
- [x] Custom input supported alongside predefined options
- [x] User answers trigger re-parsing with enriched context
- [x] Parameters fully replaced (not merged) on refinement
- [x] ParameterReview auto-refreshes after refinement

**Implementation Status:** ✅ Complete — FollowUpQuestions component, `/refine` endpoint, `paramRefreshKey` forced re-mount.

---

#### P1-08: LLM Reflection Loop (Visible Thinking)
Pre-parse "thinking" step that reasons about user intent before parameter extraction.

**Acceptance Criteria:**
- [x] Reflection covers: intent, affected business areas, assumptions, second-order effects
- [x] Thinking is visible to user in a collapsible ThinkingBlock (like ChatGPT)
- [x] Reflection context is injected into the main parser prompt for better accuracy
- [x] Duration tracked and displayed

**Implementation Status:** ✅ Complete — `reflectionService.ts`, ThinkingBlock component, visible thinking in chat.

---

#### P1-09: Multi-Period Simulation
Time-horizon-aware simulation with period-by-period breakdown.

**Acceptance Criteria:**
- [x] Supports monthly and quarterly granularity
- [x] Driver-based period-over-period value carry-forward
- [x] Aggregate + per-period P&L output
- [x] Interactive PeriodBreakdownView and TrendLineChart

**Implementation Status:** ✅ Complete — Multi-period engine with configurable horizons, Recharts visualizations.

---

#### P1-10: Document RAG — Talk to Documents (Qdrant Integration)
Upload documents, vectorize with Qdrant, and chat with document content via RAG.

**Acceptance Criteria:**
- [x] Upload PDF, TXT, MD, CSV (max 20MB) via drag-and-drop or file browser
- [x] Text extraction, chunking (500-word, 100-word overlap), vector embedding
- [x] Storage in Qdrant Cloud vector database
- [x] RAG query: vector similarity search → top-K retrieval → Claude-grounded answer
- [x] Source citations with relevance scores and expandable excerpts
- [x] Query single document or search across all documents
- [x] Document list with status indicators, delete capability
- [x] Graceful error handling (empty files, unsupported types, Qdrant disconnected)

**Implementation Status:** ✅ Complete — `embeddingService.ts`, `qdrantService.ts`, `documentService.ts`, `ragService.ts`, DocumentPanel UI.

---

#### P1-11: Quality Assurance Agent with QA-BA Reflection Loop
LLM-powered QA agent that evaluates business analysis quality and drives iterative refinement.

**Acceptance Criteria:**
- [x] QA Agent evaluates analysis across 6 dimensions: completeness, specificity, actionability, consistency, business relevance, risk coverage
- [x] Absurdity detection: flags P&L changes exceeding ±200% as inconsistent
- [x] QA-BA reflection loop: QA feedback sent directly to Business Analysis Agent for regeneration (up to 3 iterations)
- [x] Full reflection log visible to user showing each agent's thinking, scores, and actions
- [x] Analysis clearly marked as unreliable if QA threshold not met after max iterations
- [x] Robust JSON repair prevents truncation errors in LLM responses

**Implementation Status:** ✅ Complete — `qaAgent.ts` (evaluation-only), `regenerateWithFeedback()` in businessAnalysisAgent, orchestration in scenarios route, ReflectionLogSection in BusinessInsights UI.

---

#### P1-12: Dynamic Context Engine & Document-Driven Model Building
Automatically builds financial models from uploaded documents using RAG and LLM extraction.

**Acceptance Criteria:**
- [x] Extracts company context (name, industry, business model, revenue streams) from uploaded documents
- [x] Extracts financial metrics with exact values from P&L statements
- [x] Detects and respects document currency (INR, USD, etc.) and unit (Million, Crore, etc.)
- [x] Builds model with proper input/output variable classification and formula relationships
- [x] Auto-repairs broken formulas using KNOWN_CALCULATED_FORMULAS lookup
- [x] cost_of_revenue properly calculated from sub-items (employee_benefits + subcontracting + etc.)
- [x] Full document text reconstruction from Qdrant chunks for accurate LLM extraction
- [x] Document Manager UI showing extracted metrics, currency, and context

**Implementation Status:** ✅ Complete — `contextEngine.ts`, context routes, DocumentManager component, centralized currency utilities.

---

### 5.4 Future Considerations (P2)

These are out of scope for V1 but should inform architectural decisions now.

| # | Feature | Design Implication |
|---|---------|-------------------|
| P2-01 | **Structured Market Data Feeds** — Auto-populate commodity prices, FX rates, and interest rates from structured data providers | Design model input layer to accept external data sources; build parameter interface that can be populated programmatically (Perplexity search partially addresses this) |
| P2-02 | **Cross-Scenario Optimization** — Given a target metric ("Maximize EBITDA while keeping cash > $50M"), agent suggests optimal parameter combinations | Model interface should support bidirectional computation (forward simulation + inverse optimization); consider constraint solver integration |
| P2-03 | **SSO / Enterprise Authentication** — Full SSO integration with SAML/OIDC | Current RBAC middleware supports header-based auth; SSO adapter layer needed |
| P2-04 | **Document-Informed Scenario Generation** — Automatically generate scenario parameters from uploaded documents | RAG infrastructure (Qdrant) is in place; needs LLM agent to generate structured parameters from document excerpts |
| P2-05 | **Collaborative Real-Time Editing** — Multiple users editing scenario parameters simultaneously | WebSocket infrastructure for real-time sync; CRDT or OT for conflict resolution |

---

## 6. Success Metrics

### 6.1 Leading Indicators (Days–Weeks)

| Metric | Target | Stretch | Measurement Method |
|--------|--------|---------|-------------------|
| Scenario build time | < 5 min | < 2 min | Median time from NL input to output render |
| NL parse accuracy | > 90% | > 95% | % of parameters correctly extracted without user correction |
| Simulation accuracy | < 2% variance | < 1% | Agent output vs. manual spreadsheet calculation on test scenarios |
| Adoption rate | 60% of FP&A team | 80% | Unique users who run 1+ scenario within 30 days of launch |
| Task completion rate | > 85% | > 95% | % of started scenarios that produce a final output (not abandoned) |
| Document query accuracy | > 80% | > 90% | % of RAG answers that correctly reference source material |

### 6.2 Lagging Indicators (Weeks–Months)

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Scenarios per quarter | 20+ (up from 5–10) | Total completed scenarios across FP&A team per quarter |
| Executive self-service rate | 30% of scenarios | % of scenarios initiated by non-FP&A users (execs, BU heads) |
| Manual error reduction | 90% reduction | Tracked errors in scenario outputs vs. pre-agent baseline |
| Decision speed | 50% faster | Time from strategic question to scenario-informed decision (survey) |
| FP&A time reallocation | 40% time saved | Time-tracking survey: hours on scenario builds vs. strategic analysis |
| Document insight usage | 50% of scenarios | % of scenarios where analyst referenced uploaded documents |

### 6.3 Evaluation Cadence

- **2-week check:** Adoption rate + NL parse accuracy (early signal)
- **30-day review:** All leading indicators
- **90-day review:** All metrics including lagging indicators
- **Quarterly:** Full metric review with executive readout

---

## 7. Open Questions

### Resolved ✅

| # | Question | Resolution |
|---|----------|------------|
| OQ-01 | Which LLM powers the NL parser? | **Anthropic Claude Haiku 4.5** — via `@anthropic-ai/sdk`. Fast, cost-effective, high-quality structured output. |
| OQ-02 | Model registry format and API spec? | **Dynamic `ModelDefinition`** with tagged variables (`pl_metric`, `percent_delta`, `input`), centralized `computeBaseCase()` and `describeModelForLLM()`. |
| OQ-03 | Simulation compute infrastructure? | **Node.js Express server** with in-process simulation engine. 60s compute timeout. Multi-period support. |
| OQ-07 | Corporate template format for exports? | **Deloitte-branded** — green accent (#86BC25), charcoal text, clean typography. Excel, CSV, PPTX exports. |

### Non-Blocking (can resolve during next phase)

| # | Question | Owner | Context |
|---|----------|-------|---------|
| OQ-04 | What constitutes "approval" for SOX purposes? | Internal Audit | Is a button click sufficient, or do we need digital signatures / multi-party approval? |
| OQ-05 | Multi-currency scenario support? | FP&A + Product | Do scenarios need FX translation, or is USD-only acceptable? |
| OQ-06 | Data warehouse latency tolerance? | Data Engineering | How fresh must the base data be? Real-time, daily, or monthly refresh? |
| OQ-08 | Embedding quality for document RAG? | Engineering | Current local hash-based embeddings work for prototype; production should use API embeddings (OpenAI, Voyage AI) for better semantic accuracy. |

---

## 8. Timeline & Phasing

### Phase 1: Core Engine (Weeks 1–6) ✅ COMPLETE
- NL parser (P0-01)
- Parameter-to-model mapping (P0-02)
- Simulation engine (P0-03)
- Basic output (single scenario view)
- Chat interface (Claude cowork-style)
- **Milestone:** End-to-end scenario from NL input to P&L output working in dev environment

### Phase 2: Comparison & UX (Weeks 7–10) ✅ COMPLETE
- Side-by-side comparison (P0-04)
- Human review gate (P0-05)
- Narrative generation (P0-07)
- Excel/CSV export
- RBAC (P0-08)
- **Milestone:** Feature-complete for internal beta; FP&A team can run scenarios end-to-end

### Phase 3: Hardening (Weeks 11–14) ✅ COMPLETE
- Audit trail (P0-06)
- Performance tuning (60s guardrail enforcement)
- Input validation and rate limiting
- Error handling and edge cases
- **Milestone:** Production-ready; passes security review and SOX audit trail requirements

### Phase 4: P1 Features (Weeks 15–20) ✅ COMPLETE
- Monte Carlo simulation (P1-01)
- Tornado charts (P1-02)
- Template library (P1-03)
- Conversational follow-up (P1-04)
- Business Analysis Agent (P1-05)
- LLM-first dynamic parsing (replaced hardcoded parameters)
- Deloitte brand theming
- **Milestone:** Enhanced feature set live; measure adoption lift vs. P0-only baseline

### Phase 5: Intelligence, Documents & Quality (Weeks 21–28) ✅ COMPLETE
- E2E testing and quality (Weeks 21–22)
- Multi-period simulation (Week 23)
- Frontend enhancements — charts, sharing, roles, PPTX export (Week 24)
- Perplexity web search integration for macro/news/competitor scenarios (P1-06)
- Interactive follow-up questions & scenario refinement (P1-07)
- LLM reflection loop with visible thinking (P1-08)
- Claude migration (replaced OpenAI with Anthropic Claude)
- Card-strip + modal overlay UI refactor
- Document RAG — Qdrant vector search integration (P1-10)

#### Dynamic Context Engine, QA Agent & Simulation Accuracy ✅ COMPLETED

**Dynamic Context Engine:**
- [x] `contextEngine.ts`: Builds company context + financial model from uploaded documents via Claude + Qdrant RAG
- [x] Full document text reconstruction from ordered Qdrant chunks (not fragmented semantic search)
- [x] LLM prompt enforces exact P&L value extraction, respects currency unit, avoids summary tables
- [x] KNOWN_CALCULATED_FORMULAS for cost_of_revenue, ebit, ebitda, gross_profit, net_income, etc.
- [x] Auto-repair: converts input-tagged calculated variables to proper output formulas
- [x] Context API routes (`/context/build`, `/context/status`, CRUD)
- [x] DocumentManager component showing extracted metrics with currency badge

**Quality Assurance Agent:**
- [x] `qaAgent.ts`: Evaluates business analysis across 6 quality dimensions with absurdity check
- [x] `regenerateWithFeedback()` in businessAnalysisAgent: BA agent regenerates with QA criticism
- [x] Orchestration loop in scenarios route: BA → QA → if fails → BA regenerates → QA re-evaluates (up to 3 iterations)
- [x] `ReflectionLogSection` in BusinessInsights: timeline visualization of QA-BA back-and-forth
- [x] Failed QA clearly marked with warnings; analysis blocked from being presented as reliable

**Simulation Accuracy Fixes:**
- [x] Parser filters out parameters targeting calculated/output variables (only INPUT overrides allowed)
- [x] Multi-period simulation: percent_delta applied to ORIGINAL base each period (no compounding)
- [x] Post-simulation absurdity check: flags key metrics changing by >±200%
- [x] Business Analysis Agent uses single-period P&L (not 8-quarter aggregate) for accurate comparison
- [x] Increased LLM maxTokens (1500→2500-3000) with robust JSON repair to prevent truncation

**Currency & UX:**
- [x] Centralized currency formatting (`fmtCurrency`, `getCurrencySymbol`, `getCurrencyLabel`) across all components
- [x] Dynamic currency detection from company context (INR, USD, EUR, etc.)
- [x] Removed hardcoded company branding from header
- [x] Self-service role switching (RoleSwitcher component)
- [x] Scrollable thinking block in chat

**Scenario Comparison Overhaul:**
- [x] Scenarios display descriptions and dates instead of UUIDs
- [x] Checkbox-based selector with "Current" badge and date labels
- [x] Auto-generated scenario names from nl_input text
- [x] Comparison API returns `nl_input` and `created_at` alongside `name`

- **Milestone:** Full intelligence layer with document understanding, web research, visible AI reasoning, quality assurance, and dynamic model building

### Phase 6: Production Readiness (Upcoming)
- SSO / enterprise authentication integration
- Load testing and performance benchmarking
- Security audit and penetration testing
- Production deployment (containerization, CI/CD)
- User acceptance testing with FP&A team
- Monitoring, alerting, and observability
- **Milestone:** Production-grade deployment ready for enterprise rollout

### Dependencies

| Dependency | Owner | Needed By |
|------------|-------|-----------|
| Model registry API specification | Data Engineering | Phase 1 start ✅ |
| SSO / identity provider integration | Platform | Phase 6 (production) |
| Financial model definitions (at least 1 model) | FP&A | Phase 1 testing ✅ |
| Corporate export templates | Design + FP&A | Phase 2 (export) ✅ |
| Security review scheduling | InfoSec | Phase 6 start |
| Qdrant Cloud instance | Platform | Phase 5 (documents) ✅ |

---

## 9. Architecture Notes (for engineering context)

### High-Level Component Map

```
┌────────────────────────────────────────────────────────────────┐
│                     Frontend (Next.js 14 / React)               │
│  - Chat window (Claude cowork-style)                            │
│  - Card-strip + modal overlay for analysis panels               │
│  - Recharts visualizations (waterfall, trend, tornado)          │
│  - Document upload + RAG chat (DocumentPanel)                   │
│  - Export (Excel, CSV, PPTX, PNG)                               │
│  - Deloitte brand theming (Tailwind + CSS variables)            │
└────────────────────┬───────────────────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────────────────┐
│               API Gateway (Express.js, REST)                    │
│  - Auth (x-user-id), RBAC middleware, Rate Limiting             │
│  - Input validation, compute timeout enforcement                │
└────────────────────┬───────────────────────────────────────────┘
                     │
    ┌────────┬───────┼────────┬──────────┬──────────┬───────────┐
    │        │       │        │          │          │           │
┌───▼────┐┌──▼──────────┐┌───▼────┐┌────▼─────┐┌──▼──────────┐┌──▼──────────┐
│Reflect ││ Perplexity   ││ NL     ││Simulation││ Document    ││ Context     │
│Agent   ││ Search Agent ││ Parser ││ Engine   ││ RAG Service ││ Engine      │
│(Claude)││ (Sonar API)  ││(Claude)││(Multi-P) ││(Qdrant+LLM)││(Qdrant+LLM) │
└───┬────┘└──────────────┘└───┬────┘└────┬─────┘└──────┬──────┘└──────┬──────┘
    │                          │          │             │              │
┌───▼──────────────────────────▼──────────▼─────────────┘──────────────┘
│   Business Analysis Agent (Claude) │ QA Agent (Claude)  │ Narrative Gen │
└───────────────────────┬──────────────────────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────────┐
│  Data Layer                                             │
│  - PostgreSQL: scenarios, params, outputs, audit,       │
│    users, templates, sharing, documents                 │
│  - Qdrant Cloud: document chunk vectors                 │
└─────────────────────────────────────────────────────────┘
```

### Key Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| LLM | Anthropic Claude Haiku 4.5 | Fast, cost-effective, structured output, reflection capability |
| Web Search | Perplexity Sonar API | Real-time web-grounded research, high-quality summarization |
| Vector DB | Qdrant Cloud | Managed vector search, payload filtering, scalable |
| Embeddings | Local hash-based (prototype) / API-based (production) | Zero-dependency prototype; upgrade path to OpenAI/Voyage embeddings |
| Frontend | Next.js 14, React, Tailwind CSS, Recharts | Modern SSR, component architecture, rich data visualization |
| Backend | Node.js, Express, TypeScript | Type-safe, fast development, good LLM SDK support |
| Database | PostgreSQL | ACID compliance, JSONB for flexible data, UUID support |
| Context Engine | contextEngine.ts + Qdrant RAG | Document-driven model building with LLM extraction and formula repair |
| QA Agent | qaAgent.ts + Claude | Quality assurance with multi-dimensional scoring and absurdity detection |

### Key Design Decisions

1. **Model definitions are external.** The agent does not contain model logic. Models are registered via API and consumed as versioned definitions. This decouples model maintenance from agent development.

2. **Human gate is mandatory.** No simulation runs without explicit user approval of parameters. This is a hard architectural constraint, not a UI preference.

3. **Audit trail is append-only.** Records are immutable once written. No update or delete operations on audit data. Design for compliance from day one.

4. **LLM calls are centralized.** All Claude interactions go through `llmClient.ts`, making the provider swappable. Perplexity is kept separate for web search.

5. **Graceful degradation.** When AI services (Claude, Perplexity, Qdrant) are unavailable, the system falls back to heuristic parsing and provides user-visible notices explaining limitations.

6. **Card-strip + modal UI pattern.** Analysis panels appear as compact cards below the chat; clicking expands into a modal overlay. This keeps the chat visible while providing full panel functionality.

7. **RAG pipeline is document-agnostic.** The same embedding + search + generation pipeline works for any document type (PDF, TXT, MD, CSV), enabling future extension to more formats.

---

## 10. Error States & Edge Cases

| Scenario | Expected Behavior |
|----------|------------------|
| NL input is ambiguous ("costs go up") | Parser returns low confidence; generates structured follow-up questions with selectable options |
| Parameter maps to multiple model variables | Display all candidates with confidence scores; user selects correct mapping |
| Simulation exceeds 60s timeout | Job terminated; user sees: "Simulation timed out. Try reducing the number of variables or simplifying the scenario." |
| Model version referenced in audit trail no longer exists | System retains model snapshots; historical runs always reproducible |
| User submits scenario with contradictory parameters | Parser flags contradiction: "Revenue increase 20% conflicts with volume decrease 30% — please clarify intent" |
| No base case data available for comparison | Block comparison view; display: "Base case data not loaded. Please ensure current forecast is synced." |
| Export template not configured | Fall back to generic Deloitte-branded professional format |
| Concurrent users running against same model | Simulations are isolated (each gets immutable model snapshot); no cross-contamination |
| Anthropic API key missing/invalid | Heuristic parser fallback + user-visible notice: "AI service unavailable — using basic parsing" |
| Perplexity API key missing | Search skipped silently; user receives notice that real-time research is unavailable |
| Qdrant disconnected | Document upload fails gracefully with error message; RAG queries return fallback message |
| Document has no extractable text | Upload recorded as "error" status; user sees: "No text could be extracted" |
| Unsupported file type uploaded | JSON error response: "Unsupported file type. Allowed: PDF, TXT, MD, CSV" |
| User ID is email instead of UUID | `resolveUserId()` automatically resolves email to UUID via database lookup |
| PDF parser returns object instead of string | Defensive extraction handles both string and `{ text, pages, total }` return types |
