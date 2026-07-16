const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const WORKSPACE_KEY = "sm_workspace_id";

/** Access token lives in module memory only — never localStorage (XSS mitigation). */
let accessToken: string | null = null;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

/** Active workspace id (persisted). Read here — not from the store — so api.ts has no store import. */
export function getActiveWorkspaceId(): string | null {
  return storage()?.getItem(WORKSPACE_KEY) ?? null;
}

export function setActiveWorkspaceId(id: string | null): void {
  const s = storage();
  if (!s) return;
  if (id) s.setItem(WORKSPACE_KEY, id);
  else s.removeItem(WORKSPACE_KEY);
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** @deprecated refresh token is httpOnly cookie — kept for tests / body-fallback only */
export function getRefreshToken(): string | null {
  return null;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Store access token after login / refresh (refresh token is set via httpOnly cookie). */
export function setTokens(access: string): void {
  accessToken = access;
}

export function clearTokens(): void {
  accessToken = null;
}

export function isAuthenticated(): boolean {
  return !!accessToken;
}

/** Bootstrap session from httpOnly refresh cookie (page reload / OIDC return). */
export async function hydrateSessionFromCookie(): Promise<boolean> {
  if (accessToken) return true;
  return tryRefresh();
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          clearTokens();
          return false;
        }
        const data = await res.json();
        setTokens(data.access_token);
        return true;
      } catch {
        clearTokens();
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.href = `/login?next=${next}`;
}

export class ApiTimeoutError extends Error {
  constructor(ms: number) {
    super(`Request timed out after ${ms / 1000}s`);
    this.name = "ApiTimeoutError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** LLM / analysis calls (BA+QA loop, context build, parse) routinely exceed 30s. */
export const LLM_TIMEOUT_MS = 300_000;

/** fetch with a timeout, distinguishing "server took too long" from other network errors. */
async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Respect a caller-supplied signal too (e.g. component unmount cancellation).
  if (init.signal) {
    init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal, credentials: init.credentials ?? "include" });
  } catch (e) {
    if (controller.signal.aborted && !(init.signal?.aborted)) {
      throw new ApiTimeoutError(timeoutMs);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function buildAuthHeaders(init: RequestInit): Headers {
  const headers = new Headers(init.headers || {});
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) headers.set("X-Workspace-Id", workspaceId);
  if (init.body && !headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

export type ApiFetchInit = RequestInit & { timeoutMs?: number };

/** Authenticated fetch: Bearer token + workspace header, timeout, 401 → refresh → retry → login redirect. */
export async function apiFetch(input: string, init: ApiFetchInit = {}, timeoutMs?: number): Promise<Response> {
  // Prefer explicit 3rd arg, then init.timeoutMs, then default — so LLM callers can't silently get 30s.
  const { timeoutMs: initTimeoutMs, ...fetchInit } = init;
  const ms = timeoutMs ?? initTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res = await fetchWithTimeout(input, { ...fetchInit, headers: buildAuthHeaders(fetchInit) }, ms);
  if (res.status === 401 && !input.includes("/api/v1/auth/")) {
    const ok = await tryRefresh();
    if (ok) {
      res = await fetchWithTimeout(input, { ...fetchInit, headers: buildAuthHeaders(fetchInit) }, ms);
    }
    if (res.status === 401) {
      clearTokens();
      redirectToLogin();
    }
  }
  // Stale workspace (deleted in another tab): drop it and retry on the default workspace.
  if (res.status === 403 && getActiveWorkspaceId()) {
    try {
      const body = await res.clone().json();
      if (body?.code === "WORKSPACE_NOT_FOUND") {
        setActiveWorkspaceId(null);
        res = await fetchWithTimeout(input, { ...fetchInit, headers: buildAuthHeaders(fetchInit) }, ms);
      }
    } catch {
      // Non-JSON 403 — leave as-is.
    }
  }
  return res;
}

export interface ParsedParameter {
  name: string;
  variable_type: string;
  direction: string;
  magnitude: number;
  unit: string;
  scope: Record<string, string>;
  confidence: number;
  mapped_variable_id?: string;
}

export interface SearchContext {
  query: string;
  summary: string;
  data_points: string[];
  sources: string[];
}

export interface RecommendationEvidence {
  kind: "model" | "document" | "context" | "web";
  source: string;
  snippet?: string;
}

export interface FollowUpRecommendation {
  value: string;
  label?: string;
  rationale: string;
  confidence: number;
  evidence: RecommendationEvidence[];
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  options: { label: string; value: string }[];
  allow_custom?: boolean;
  question_type?: "choice" | "open";
  recommendation?: FollowUpRecommendation;
}

export interface FollowUpAnswer {
  question_id: string;
  answer: string;
  answer_kind?: "accepted_recommendation" | "overridden" | "custom" | "comment";
  recommended_value?: string;
}

export interface ReflectionData {
  thinking: string;
  intent: string;
  assumptions: string[];
  second_order_effects: string[];
  duration_ms: number;
}

export interface Notice {
  type: "warning" | "info";
  message: string;
}

export interface ParseScenarioResponse {
  scenario_id?: string;
  parameters: ParsedParameter[];
  clarification_needed?: string;
  follow_up_questions?: FollowUpQuestion[];
  search_context?: SearchContext;
  reflection?: ReflectionData;
  notices?: Notice[];
  agent_trace?: Array<{ tool: string; input: unknown; output: unknown }>;
  causal_chain?: Array<{
    step: string;
    detail?: string;
    kind?: "decomposition" | "research" | "levers" | "preview" | "other";
  }>;
  citations?: Array<{ source: string; snippet?: string; url?: string }>;
  agent_confidence?: number;
  preview_pl?: Record<string, number>;
  preview_reconciliation?: {
    reconciled: boolean;
    max_abs_diff: number;
    diffs?: Record<string, { preview: number; final: number; abs_diff: number }>;
    message?: string;
  };
  constraint_violations?: Array<{ lever: string; reason: string }>;
  agent_readiness?: {
    enabled: boolean;
    model_validated: boolean;
    ready: boolean;
    reasons: string[];
  };
}

export interface TouchedLever {
  id: string;
  originalValue: number;
  userValue: number;
  source: string;
  confidence: number;
  nlSource: string;
  locked: boolean;
}

export interface ScenarioContextPayload {
  scenario_id: string;
  context: {
    activeScenarioLabel: string;
    touchedLevers: TouchedLever[];
    constraints: Array<{
      type: "ceiling" | "floor";
      lever: string;
      max?: number;
      min?: number;
      reason: string;
    }>;
  };
}

export interface StoredParameter {
  parameter_id: string;
  extracted_name: string;
  mapped_variable_id: string;
  base_value: number | null;
  scenario_value: number;
  delta_type?: "percent" | "absolute" | "additive";
  member_scope?: Record<string, string> | null;
  member_catalog?: MemberCatalog;
  confidence_score: number;
  status: string;
}

export interface ScenarioRef {
  scenario_id: string;
  name: string | null;
  nl_input: string;
  created_at: string;
}

export interface ComparisonRow {
  metric: string;
  base: number;
  scenarios: (ScenarioRef & { value: number; delta: number; delta_pct: number | null })[];
}

export interface ComparisonResult {
  scenarios: ScenarioRef[];
  metrics: ComparisonRow[];
  assumption_diff: { parameter: string; base_value: string; scenarios: (ScenarioRef & { value: string })[] }[];
  key_callouts: { label: string; base: number; scenario: number; delta: number; delta_pct: number | null }[];
}

// ── Scenarios ──

export async function parseScenario(nlInput: string): Promise<ParseScenarioResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nl_input: nlInput }),
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function refineScenario(
  scenarioId: string,
  answers: FollowUpAnswer[]
): Promise<ParseScenarioResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Refine failed: ${res.status}`);
  }
  return res.json();
}

export async function getParameters(scenarioId: string): Promise<StoredParameter[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/parameters`);
  if (!res.ok) throw new Error("Failed to get parameters");
  const data = await res.json();
  const parameters: StoredParameter[] = data.parameters ?? [];
  return data.member_catalog
    ? parameters.map((parameter) => ({
        ...parameter,
        member_catalog: parameter.member_catalog ?? data.member_catalog,
      }))
    : parameters;
}

export async function getScenarioContext(scenarioId: string): Promise<ScenarioContextPayload> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/context`);
  if (!res.ok) throw new Error("Failed to get scenario context");
  return res.json();
}

export async function lockScenarioLever(
  scenarioId: string,
  leverId: string,
  locked: boolean,
): Promise<ScenarioContextPayload> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/context/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lever_id: leverId, locked }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to lock lever");
  }
  return res.json();
}

export async function resetScenarioUnlockedLevers(scenarioId: string): Promise<ScenarioContextPayload> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/context/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error("Failed to reset unlocked levers");
  return res.json();
}

export async function previewScenario(
  scenarioId: string,
  parameters?: Array<{ variable_id: string; value: number; delta_type?: "percent" | "absolute" | "additive" }>,
): Promise<{
  pl?: Record<string, number>;
  aggregate?: Record<string, number>;
  notices?: Array<string | { message?: string }>;
  levers?: Array<{ id: string; name: string; base: number }>;
  ignored_overrides?: string[];
  [key: string]: unknown;
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parameters }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Preview failed");
  }
  return res.json();
}

export async function getScenarioOutputs(
  scenarioId: string,
): Promise<Array<{ output_id: string; output_type: string; output_data: unknown; narrative_summary?: string | null; created_at: string }>> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/outputs`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to get outputs");
  }
  const data = await res.json();
  return data.outputs ?? [];
}

export async function updateParameter(
  scenarioId: string,
  paramId: string,
  updates: { scenario_value?: number; status?: string }
): Promise<StoredParameter> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/parameters/${paramId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update parameter");
  return res.json();
}

export async function approveScenario(scenarioId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Approval failed");
  }
}

export interface PeriodResult {
  period: string;
  pl: Record<string, number>;
}

export interface SimulationResult {
  scenario_id: string;
  pl: Record<string, number>;
  variables: Record<string, number>;
  periods?: PeriodResult[];
  period_count?: number;
  granularity?: "monthly" | "quarterly";
  absurdity_warnings?: string[];
  formula_error_metrics?: Array<{ metric_id: string; raw_value?: unknown; reason: string }>;
  simulation_mode?: "formula_dag" | "xlsx_cell_graph" | "external_model";
  dimensional?: DimensionalResultBlock;
  notices?: Array<string | Notice>;
  fidelity?: {
    checked: true;
    applied_repairs: string[];
    violations: Array<{
      code: string;
      severity: string;
      metric: string;
      message: string;
      expected?: number;
      actual?: number;
    }>;
    normalized: boolean;
  };
}

export type MemberCatalog = Record<
  string,
  Array<{ id: string; name: string } | string> | Record<string, string>
>;

export interface DimensionalResultBlock {
  dimensions: Array<{ id: string; name: string; type: string }>;
  breakdowns: Record<string, Record<string, Record<string, number>>>;
  member_catalog?: MemberCatalog;
}

export interface PovSliceResult {
  scenario_id?: string;
  pov: Record<string, string>;
  pl?: Record<string, number>;
  periods?: PeriodResult[];
  granularity?: "monthly" | "quarterly";
  dimensional?: DimensionalResultBlock;
  notices?: Array<string | Notice>;
}

export async function getBaseCase(): Promise<{ pl: Record<string, number>; all_variables: Record<string, number> }> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/base-case`);
  if (!res.ok) throw new Error("Failed to get base case");
  return res.json();
}

export async function runScenario(scenarioId: string): Promise<SimulationResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Simulation failed");
  }
  return res.json();
}

export async function getPovSlice(
  scenarioId: string,
  pov: Record<string, string>,
  metrics?: string[],
): Promise<PovSliceResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/pov-slice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pov, ...(metrics?.length ? { metrics } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to load POV slice");
  }
  return res.json();
}

export async function generateNarrative(scenarioId: string, audience: "board" | "internal" = "internal"): Promise<string> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/narrative`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audience }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Narrative generation failed");
  }
  const data = await res.json();
  return data.narrative;
}

/**
 * Stream narrative progress via SSE (`POST …/narrative/stream`).
 * Falls back to non-streaming `generateNarrative` if the stream is unavailable.
 *
 * SSE events: `progress` → `done` { narrative } | `error` → `end`
 * Also: `POST /api/v1/scenarios/reflect/stream` for reflection progress.
 */
export async function generateNarrativeStream(
  scenarioId: string,
  audience: "board" | "internal" = "internal",
  onProgress?: (stage: string, detail?: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const res = await apiFetch(
      `${API_BASE}/api/v1/scenarios/${scenarioId}/narrative/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ audience }),
        signal,
      },
      120_000,
    );
    if (!res.ok || !res.body) {
      return generateNarrative(scenarioId, audience);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let narrative: string | null = null;
    let streamError: string | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";
      for (const chunk of parts) {
        const lines = chunk.split("\n");
        let event = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as {
            stage?: string;
            detail?: string;
            narrative?: string;
            error?: string;
          };
          if (event === "progress" && onProgress) {
            onProgress(parsed.stage || "progress", parsed.detail);
          } else if (event === "done" && parsed.narrative) {
            narrative = parsed.narrative;
          } else if (event === "error") {
            streamError = parsed.error || "Narrative stream failed";
          }
        } catch {
          // ignore malformed SSE frames
        }
      }
    }

    if (streamError) throw new Error(streamError);
    if (narrative) return narrative;
    return generateNarrative(scenarioId, audience);
  } catch {
    return generateNarrative(scenarioId, audience);
  }
}

export async function compareScenarios(scenarioIds: string[]): Promise<ComparisonResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario_ids: scenarioIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Comparison failed");
  }
  return res.json();
}

export async function listScenarios(): Promise<{ scenario_id: string; name: string | null; nl_input: string; status: string; created_at: string }[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios`);
  if (!res.ok) throw new Error("Failed to list scenarios");
  const data = await res.json();
  return data.scenarios;
}

export async function deleteScenario(scenarioId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${encodeURIComponent(scenarioId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to delete scenario");
  }
}

export async function deleteScenarios(
  scenarioIds: string[],
): Promise<{ deleted: string[]; failed: Array<{ scenario_id: string; error: string }> }> {
  if (scenarioIds.length === 0) return { deleted: [], failed: [] };
  if (scenarioIds.length === 1) {
    await deleteScenario(scenarioIds[0]);
    return { deleted: scenarioIds, failed: [] };
  }
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/bulk-delete`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ scenario_ids: scenarioIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to delete scenarios");
  }
  return res.json();
}

// ── Exports ──

export function getExcelExportUrl(scenarioId: string): string {
  return `${API_BASE}/api/v1/scenarios/${scenarioId}/export/excel`;
}

export function getCsvExportUrl(scenarioId: string): string {
  return `${API_BASE}/api/v1/scenarios/${scenarioId}/export/csv`;
}

// ── Audit Trail ──

export interface AuditEntry {
  audit_id: string;
  scenario_id: string;
  action_type: string;
  user_id: string;
  action_details: Record<string, unknown> | null;
  timestamp: string;
}

export async function getAuditTrail(params: {
  scenario_id?: string;
  limit?: number;
  offset?: number;
}): Promise<{ entries: AuditEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.scenario_id) qs.set("scenario_id", params.scenario_id);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.offset) qs.set("offset", String(params.offset));
  const res = await apiFetch(`${API_BASE}/api/v1/audit?${qs.toString()}`);
  if (!res.ok) throw new Error("Failed to get audit trail");
  return res.json();
}

// ── Auth ──

export interface AuthUser {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface AuthResponse {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Login failed");
  }
  const data = await res.json();
  setTokens(data.access_token);
  return data;
}

export async function getAuthConfig(): Promise<{
  auth_provider: "local" | "oidc";
  oidc_enabled: boolean;
}> {
  const res = await fetch(`${API_BASE}/api/v1/auth/config`);
  if (!res.ok) return { auth_provider: "local", oidc_enabled: false };
  return res.json();
}

/** Browser navigates to the API authorize endpoint (302 → IdP). */
export function oidcAuthorizeHref(nextPath = "/"): string {
  const next = nextPath.startsWith("/") ? nextPath : "/";
  // Callback will redirect to FRONTEND with tokens when IdP returns; authorize starts the flow.
  return `${API_BASE}/api/v1/auth/oidc/authorize?next=${encodeURIComponent(next)}`;
}

export async function register(email: string, password: string, name?: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Registration failed");
  }
  const data = await res.json();
  if (data.access_token) setTokens(data.access_token);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({}),
    });
  } finally {
    clearTokens();
  }
}

/** @deprecated use isAuthenticated — kept for ChatWindow boot */
export async function initUserContext(): Promise<void> {
  if (!getAccessToken()) redirectToLogin();
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra || {}) };
  const token = getAccessToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) headers["X-Workspace-Id"] = workspaceId;
  return headers;
}

// ── Workspaces ──

export interface Workspace {
  workspace_id: string;
  name: string;
  is_default: boolean;
  document_count?: number;
  scenario_count?: number;
  created_at: string;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/workspaces`);
  if (!res.ok) throw new Error("Failed to list workspaces");
  const data = await res.json();
  return data.workspaces ?? [];
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const res = await apiFetch(`${API_BASE}/api/v1/workspaces`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to create workspace");
  return data;
}

export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  const res = await apiFetch(`${API_BASE}/api/v1/workspaces/${id}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to rename workspace");
  return data;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/workspaces/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete workspace");
  }
}

// ── Users ──

export interface UserProfile {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  department: string | null;
}

export async function getCurrentUser(): Promise<UserProfile> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/me`);
  if (!res.ok) throw new Error("Failed to get user profile");
  return res.json();
}

export interface RoleDescriptor {
  id: string;
  label: string;
  description: string;
}

export async function getRoles(): Promise<RoleDescriptor[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/roles`);
  if (!res.ok) throw new Error("Failed to get roles");
  const data = await res.json();
  return data.roles ?? [];
}

export async function listUsers(): Promise<UserProfile[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/users`);
  if (!res.ok) throw new Error("Failed to list users");
  return res.json();
}

export async function updateUserRole(userId: string, role: string): Promise<UserProfile> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/${userId}/role`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) throw new Error("Failed to update role");
  return res.json();
}

// ── Sharing ──

export interface SharingRecord {
  sharing_id: string;
  shared_with: string;
  email: string;
  name: string | null;
  permission: "view" | "edit";
  created_at: string;
}

export async function shareScenario(scenarioId: string, sharedWith: string, permission: "view" | "edit" = "view"): Promise<SharingRecord> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario_id: scenarioId, shared_with: sharedWith, permission }),
  });
  if (!res.ok) throw new Error("Failed to share scenario");
  return res.json();
}

export async function getShares(scenarioId: string): Promise<SharingRecord[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/shares/${scenarioId}`);
  if (!res.ok) throw new Error("Failed to list shares");
  return res.json();
}

export async function revokeShare(sharingId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/users/share/${sharingId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to revoke share");
}

// ── PowerPoint Export ──

export function getPptxExportUrl(scenarioId: string): string {
  return `${API_BASE}/api/v1/scenarios/${scenarioId}/export/pptx`;
}

/**
 * Download a file via fetch (sends auth headers), then trigger browser download.
 * Works for Excel, CSV, and PPTX exports that require Bearer header.
 */
export async function downloadWithAuth(url: string, filename: string): Promise<void> {
  const res = await apiFetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error || `Download failed: ${res.status}`);
  }
  const blob = await res.blob();
  const blobUrl = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(blobUrl);
}

// ── Monte Carlo ──

export interface PercentileResult {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  var_5: number;
  cvar_5: number;
  prob_negative: number;
  mean_ci_95: [number, number];
}

export interface FanChartBand {
  p5: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface MonteCarloResult {
  iterations: number;
  requested_iterations: number;
  seed: number;
  metrics: Record<string, PercentileResult>;
  distributions: Record<string, number[]>;
  fan_chart: Record<string, FanChartBand>;
  correlations_applied: boolean;
  notices?: string[];
  fitted_assumptions?: {
    distributions: { variable_id: string; type: string; base_value: number; stddev?: number }[];
    correlations: CorrelationSpec[];
    sample_counts: Record<string, number>;
  };
}

export interface CorrelationSpec {
  a: string;
  b: string;
  rho: number;
}

export async function runMonteCarlo(
  scenarioId: string,
  iterations = 5000,
  distributions: { variable_id: string; type: string; base_value: number; stddev?: number; min?: number; max?: number; delta_type?: "percent" | "absolute" }[] = [],
  correlations: CorrelationSpec[] = [],
  seed?: number,
  /** Optional historical samples; when omitted the backend auto-loads from workspace tabular/SAC data. */
  historicalSamples?: Record<string, number[]>,
): Promise<MonteCarloResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/monte-carlo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      iterations,
      distributions,
      correlations,
      seed,
      ...(historicalSamples ? { historical_samples: historicalSamples } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Monte Carlo failed");
  }
  return res.json();
}

// ── Sensitivity / Tornado ──

export interface TornadoBar {
  variable_id: string;
  variable_name: string;
  low_value: number;
  high_value: number;
  base_value: number;
  low_delta: number;
  high_delta: number;
  spread: number;
  absolute_step?: boolean;
}

export interface SensitivityResult {
  target_metric: string;
  swing_pct: number;
  base_metric_value: number;
  scenario_applied?: boolean;
  bars: TornadoBar[];
  notices?: string[];
  /** Per-driver swing magnitudes (from MC fitted volatility when available). */
  swing_by_variable?: Record<string, number>;
}

export async function runSensitivity(
  scenarioId: string,
  targetMetric = "net_income",
  swingPct = 20
): Promise<SensitivityResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/sensitivity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_metric: targetMetric, swing_pct: swingPct }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Sensitivity analysis failed");
  }
  return res.json();
}

export interface TwoWayGridResult {
  target_metric: string;
  variable_a: string;
  variable_b: string;
  variable_a_name: string;
  variable_b_name: string;
  base_metric_value: number;
  swings_a: number[];
  swings_b: number[];
  grid: number[][];
  values_a: number[];
  values_b: number[];
  notices?: string[];
}

export async function runTwoWaySensitivity(
  scenarioId: string,
  variableA: string,
  variableB: string,
  targetMetric = "net_income",
  swings?: number[],
): Promise<TwoWayGridResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/sensitivity/two-way`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target_metric: targetMetric,
      variable_a: variableA,
      variable_b: variableB,
      ...(swings ? { swings } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Two-way sensitivity failed");
  }
  return res.json();
}

export interface AttributionBar {
  variable_id: string;
  variable_name: string;
  contribution: number;
  residual?: boolean;
  rationale?: string;
}

export interface AttributionResult {
  target_metric: string;
  base_value: number;
  scenario_value: number;
  total_delta: number;
  method: string;
  bars: AttributionBar[];
  notices?: string[];
  driver_groups?: Array<{ category: string; variable_ids: string[]; rationale?: string }>;
  rationale?: string;
}

export async function runAttribution(
  scenarioId: string,
  targetMetric = "net_income",
  opts?: { reason?: boolean },
): Promise<AttributionResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/attribution`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_metric: targetMetric, reason: opts?.reason ?? false }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Attribution failed");
  }
  return res.json();
}

export interface GoalSeekResult {
  variable_id: string;
  target_metric: string;
  target_value: number;
  solved_value: number | null;
  achieved_metric: number | null;
  iterations: number;
  converged: boolean;
  diagnostics: Record<string, unknown>;
}

export async function runGoalSeek(
  scenarioId: string,
  variableId: string,
  targetValue: number,
  targetMetric = "net_income",
): Promise<GoalSeekResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/goal-seek`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variable_id: variableId,
      target_value: targetValue,
      target_metric: targetMetric,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Goal seek failed");
  }
  return res.json();
}

/** Upsert a scenario parameter from goal-seek / driver-tree (pending until approval). */
export async function applyLeverValue(
  scenarioId: string,
  variableId: string,
  scenarioValue: number,
  opts?: { delta_type?: "percent" | "absolute" | "additive"; reason?: string; status?: string },
): Promise<{
  parameter_id: string;
  mapped_variable_id: string;
  scenario_value: number;
  delta_type: string;
  status: string;
  created: boolean;
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/parameters/apply-lever`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variable_id: variableId,
      scenario_value: scenarioValue,
      ...(opts?.delta_type ? { delta_type: opts.delta_type } : {}),
      ...(opts?.reason ? { reason: opts.reason } : {}),
      ...(opts?.status ? { status: opts.status } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to apply lever value");
  }
  return res.json();
}

export interface DriverTreeNode {
  id: string;
  name: string;
  value: number;
  editable?: boolean;
  children?: DriverTreeNode[];
  rationale?: string;
}

export interface DriverTreeResult {
  target_metric: string;
  root: DriverTreeNode;
  model_kind: string;
  apply_path?: string;
  rationale?: string;
  grouping?: Array<{ category: string; member_ids: string[]; rationale?: string }>;
  reconciliation?: {
    ok: boolean;
    failures: Array<{ node_id: string; expected: number; actual: number; message: string }>;
  };
}

export async function fetchDriverTree(
  scenarioId: string,
  metric = "net_income",
  opts?: { reason?: boolean },
): Promise<DriverTreeResult> {
  const qs = new URLSearchParams({ metric });
  if (opts?.reason) qs.set("reason", "true");
  const res = await apiFetch(
    `${API_BASE}/api/v1/scenarios/${scenarioId}/driver-tree?${qs.toString()}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Driver tree failed");
  }
  return res.json();
}

export interface FidelityAuditResult {
  initial_violations: Array<{
    code: string;
    severity: string;
    metric: string;
    message: string;
    expected?: number;
    actual?: number;
  }>;
  deterministic: {
    applied: string[];
    residual: Array<{ code: string; severity: string; metric: string; message: string }>;
    pl: Record<string, number>;
  };
  agent: {
    findings: Array<{ code: string; severity: string; metric: string; message: string }>;
    proposed_fixes: Array<{
      kind: string;
      metric: string;
      proposed_value?: number | null;
      rationale: string;
    }>;
    applied_fixes: Array<{ kind: string; metric: string; rationale: string }>;
    residual_violations: Array<{ code: string; severity: string; metric: string; message: string }>;
    notices: string[];
    summary: string;
    applied_pl?: Record<string, number>;
  };
}

export async function runFidelityAudit(scenarioId: string): Promise<FidelityAuditResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/fidelity-audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Fidelity audit failed");
  }
  return res.json();
}

// ── Templates ──

export interface Template {
  template_id: string;
  name: string;
  description: string | null;
  parameter_set: { variable_id: string; value: number; label: string }[];
  is_shared: boolean;
  sharing_scope: string;
  version: number;
  created_at: string;
}

export async function listTemplates(scope?: string): Promise<Template[]> {
  const qs = scope ? `?scope=${scope}` : "";
  const res = await apiFetch(`${API_BASE}/api/v1/templates${qs}`);
  if (!res.ok) throw new Error("Failed to list templates");
  const data = await res.json();
  return data.templates;
}

export async function saveAsTemplate(
  scenarioId: string,
  name: string,
  description?: string,
  isShared = false
): Promise<Template> {
  const res = await apiFetch(`${API_BASE}/api/v1/templates/from-scenario/${scenarioId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, is_shared: isShared }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to save template");
  }
  return res.json();
}

export async function cloneTemplate(templateId: string, nlInput?: string): Promise<{ scenario_id: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/templates/${templateId}/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nl_input: nlInput }),
  });
  if (!res.ok) throw new Error("Failed to clone template");
  return res.json();
}

// ── Business Analysis Agent ──

export interface BusinessImplication {
  title: string;
  detail: string;
  severity: "positive" | "negative" | "neutral";
}

export interface BusinessRisk {
  risk: string;
  likelihood: "high" | "medium" | "low";
  mitigation: string;
}

export interface BusinessRecommendation {
  action: string;
  priority: "immediate" | "short-term" | "monitor";
  rationale: string;
  owner?: string;
  /** In-app remediation deep-link */
  cta?: "open_doc_manager_model" | "open_review" | "refresh_analysis" | "open_doc_manager";
}

export interface QADimension {
  name: string;
  score: number;
  feedback: string;
}

export interface QAReport {
  overall_score: number;
  passed: boolean;
  dimensions: QADimension[];
  improvement_guidance: string;
  summary: string;
  iterations: number;
  /** "not_assessed" when QA could not run (no API key / LLM failure) */
  status?: "assessed" | "not_assessed";
}

export interface ReflectionStep {
  agent: "Business Analysis" | "Quality Assurance";
  action: string;
  detail: string;
  score?: number;
  passed?: boolean;
  duration_ms: number;
}

export interface BusinessInsight {
  headline: string;
  implications: BusinessImplication[];
  risks: BusinessRisk[];
  recommendations: BusinessRecommendation[];
  decision_context: string;
  confidence_note: string;
  analysis_mode?: "standard" | "integrity";
  mode_reasons?: string[];
  qa_report?: QAReport | null;
  reflection_log?: ReflectionStep[];
}

/** Load the latest persisted business analysis (404 if none yet). */
export async function getBusinessAnalysis(scenarioId: string): Promise<BusinessInsight | null> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/business-analysis`, {
    cache: "no-store",
  });
  if (res.status === 404 || res.status === 304) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to load business analysis");
  }
  return res.json();
}

export async function generateBusinessAnalysis(scenarioId: string): Promise<BusinessInsight> {
  // BA + up to 3 QA/refine LLM rounds routinely exceeds the default 30s client timeout.
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/business-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Business analysis failed");
  }
  return res.json();
}

// ── Documents (RAG / Talk-to-Document) ──

export interface IngestionReport {
  artifact_version?: number;
  document_kind?: "spreadsheet_model" | "tabular_data" | "document_text";
  parser?: string;
  currency?: string;
  unit?: string;
  sheetCount?: number;
  formulaCount?: number;
  crossSheetLinkCount?: number;
  cellCount?: number;
  namedRangeCount?: number;
  warnings?: Array<{ code: string; message: string; sheet?: string; cell?: string }>;
  executable?: boolean;
  summary?: string;
  classification_evidence?: {
    has_formulas?: boolean;
    has_scenario_toggles?: boolean;
    has_assumption_sheets?: boolean;
    formula_count?: number;
    assumption_sheet_names?: string[];
    reason?: string;
  };
}

export interface FidelityDivergence {
  sheet: string;
  cell: string;
  expected: number;
  actual: number;
  abs_delta: number;
  rel_delta: number;
  is_key_output?: boolean;
}

export interface FidelityUnsupportedCell {
  sheet: string;
  cell: string;
  reason: string;
  formula?: string;
}

export interface FidelityReport {
  score: number;
  key_output_score: number;
  divergences: FidelityDivergence[];
  unsupported_cells: FidelityUnsupportedCell[];
  missing_expected_key_outputs?: Array<{ id?: string; sheet: string; cell: string }>;
  ready: boolean;
  compared_cells?: number;
  key_outputs_compared?: number;
}

export interface TieOutVariance {
  variable_id: string;
  extracted: number;
  computed: number;
  variance_pct: number;
  message: string;
}

export interface DocumentRecord {
  document_id: string;
  name: string;
  original_filename: string;
  file_type: string;
  document_kind?: "spreadsheet_model" | "tabular_data" | "document_text";
  validation_status?: "processing" | "needs_validation" | "ready" | "error";
  workbook_graph?: Record<string, unknown> | null;
  workbook_snapshot?: Record<string, unknown> | null;
  tabular_artifact?: Record<string, unknown> | null;
  ingestion_report?: IngestionReport | null;
  model_schema?: Record<string, unknown> | null;
  file_size_bytes: number;
  chunk_count: number;
  status: string;
  created_at: string;
}

export interface RAGSource {
  text: string;
  document_name: string;
  chunk_index: number;
  score: number;
}

export interface RAGResponse {
  answer: string;
  sources: RAGSource[];
  notice?: string;
  conversation_id?: string;
  retrieval?: "keyword" | "hybrid";
}

export async function uploadDocument(file: File): Promise<DocumentRecord> {
  const formData = new FormData();
  formData.append("file", file);
  const res = await apiFetch(`${API_BASE}/api/v1/documents/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

export async function listDocuments(): Promise<DocumentRecord[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents`);
  if (!res.ok) throw new Error("Failed to list documents");
  const data = await res.json();
  return data.documents;
}

export async function queryDocument(
  documentId: string,
  question: string,
  conversationId?: string,
): Promise<RAGResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/${documentId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, conversation_id: conversationId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Query failed: ${res.status}`);
  }
  return res.json();
}

export async function queryAllDocuments(
  question: string,
  conversationId?: string,
): Promise<RAGResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, conversation_id: conversationId }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Query failed: ${res.status}`);
  }
  return res.json();
}

export async function getDocumentConversationMessages(
  conversationId: string,
): Promise<{ conversation_id: string; messages: Array<{ role: string; content: string; sources?: RAGSource[]; created_at: string }> }> {
  const res = await apiFetch(
    `${API_BASE}/api/v1/documents/conversations/${conversationId}/messages`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error("Failed to load conversation");
  return res.json();
}

export async function deleteDocument(documentId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/${documentId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to delete document");
}

export async function checkParserHealth(): Promise<{
  parser: string;
  configured: boolean;
  status: string;
  fallback: string;
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/health/parser`);
  if (!res.ok) throw new Error("Parser health check failed");
  return res.json();
}

/** @deprecated use checkParserHealth */
export async function checkQdrantHealth(): Promise<{ qdrant: string; parser?: string; configured?: boolean }> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/health/qdrant`);
  if (!res.ok) throw new Error("Parser health check failed");
  return res.json();
}

// ── Context Engine ──

export interface CompanyContextData {
  company_name: string;
  industry: string;
  currency?: string;
  currency_unit?: string;
  business_model: string;
  revenue_streams: string[];
  financial_metrics: {
    name: string;
    variable_id: string;
    description: string;
    typical_value?: number;
    unit: string;
    metric_type?: "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";
    source_header?: string;
    source_column?: string;
    source_section?: string;
    category: string;
    is_input: boolean;
    formula?: string;
    dependencies?: string[];
  }[];
  header_mapping_suggestions?: {
    header_pattern: string;
    inferred_metric_type: "currency" | "count" | "percent" | "ratio" | "volume" | "unknown";
    expected_unit: string;
    mapping_guidance: string;
    sample_variable_ids: string[];
  }[];
  competitive_landscape: string;
  key_risks: string[];
  benchmarks: Record<string, string>;
  model_schema?: {
    company?: string;
    industry?: string;
    scenarioLevers?: { id: string; label: string; type?: string }[];
    outputMetrics?: { id: string; label: string; isKPI?: boolean }[];
    timeDimension?: { granularity?: string; periods?: number; columns?: string[] };
  };
  workbook_graph?: Record<string, unknown>;
  ingestion_report?: IngestionReport | null;
  executable_engine?: string;
  catalog_only_model_definition?: boolean;
  validation_status?: "processing" | "needs_validation" | "ready";
  usability?: "usable" | "needs_review";
  tie_out_status?: "ok" | "variances";
  tie_out_variances?: TieOutVariance[];
  runtime_validation?: {
    bound_levers?: string[];
    bound_outputs?: string[];
    warnings?: string[];
    fidelity?: FidelityReport;
  };
}

export interface CompanyContext {
  context_id: string;
  company_name: string | null;
  industry: string | null;
  context_data: CompanyContextData;
  source_document_ids: string[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface UserModel {
  model_id: string;
  name: string;
  model_definition: {
    model_version: string;
    variables: { id: string; name: string; formula: string; dependencies: string[]; tags?: string[] }[];
    time_horizon: { start: string; end: string; granularity: string };
  };
  is_active: boolean;
  created_at: string;
}

export interface OnboardingStatus {
  has_context: boolean;
  has_model: boolean;
  company_name: string | null;
  industry: string | null;
  model_name: string | null;
  currency: string | null;
  currency_unit: string | null;
  ready: boolean;
}

export async function getOnboardingStatus(): Promise<OnboardingStatus> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/status`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to check status");
  return res.json();
}

export async function buildContext(): Promise<CompanyContext> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/build`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    timeoutMs: LLM_TIMEOUT_MS,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Context build failed");
  }
  return res.json();
}

export async function getCompanyContext(): Promise<{
  context: CompanyContext | null;
  message?: string;
  model_intelligence?: {
    document_id: string;
    validation_status: "processing" | "needs_validation" | "ready";
    ingestion_report?: IngestionReport | null;
    has_snapshot?: boolean;
    sheet_count?: number;
    document_kind?: string;
  } | null;
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/context`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to get context");
  return res.json();
}

export async function updateCompanyContext(updates: Partial<CompanyContextData>): Promise<CompanyContext> {
  const res = await apiFetch(`${API_BASE}/api/v1/context`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update context");
  return res.json();
}

export async function deleteCompanyContext(): Promise<void> {
  await apiFetch(`${API_BASE}/api/v1/context`, {
    method: "DELETE",
    headers: authHeaders(),
  });
}

export async function getActiveModel(): Promise<{ model: UserModel | null; message?: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/model`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to get model");
  return res.json();
}

export async function updateActiveModel(modelDefinition: UserModel["model_definition"]): Promise<{ model: UserModel }> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/model`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model_definition: modelDefinition }),
  });
  if (!res.ok) throw new Error("Failed to update model");
  return res.json();
}

export async function validateModelSchema(documentId?: string): Promise<{
  validated: boolean;
  document_id: string;
  validation_status: "ready" | "needs_validation";
  bound_levers?: string[];
  bound_outputs?: string[];
  warnings?: string[];
  fidelity?: FidelityReport;
  error?: string;
  errors?: string[];
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/model/validate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(documentId ? { document_id: documentId } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const detail = err as {
      error?: string;
      errors?: string[];
      reason?: string;
      fidelity?: FidelityReport;
    };
    const msg = [
      detail.error || "Validation failed",
      detail.reason ? `(${detail.reason})` : "",
      ...(detail.errors || []).slice(0, 3),
    ]
      .filter(Boolean)
      .join(" — ");
    const e = new Error(msg) as Error & { fidelity?: FidelityReport };
    e.fidelity = detail.fidelity;
    throw e;
  }
  return res.json();
}

// ── Sessions (Conversational Follow-up) ──

export async function createSession(scenarioId: string): Promise<{ session_id: string; scenario_id: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario_id: scenarioId }),
  });
  if (!res.ok) throw new Error("Failed to create session");
  return res.json();
}

export async function addFollowUp(
  sessionId: string,
  nlInput: string
): Promise<{
  added_parameters: { name: string; mapped_variable_id: string; scenario_value: number }[];
  cumulative_count: number;
  clarification_needed?: string;
}> {
  const res = await apiFetch(`${API_BASE}/api/v1/sessions/${sessionId}/follow-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nl_input: nlInput }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Follow-up failed");
  }
  return res.json();
}

// ── Planning connections (SAP SAC / mock) ──

export interface AppFeatures {
  planning_connectors_enabled: boolean;
}

export async function getAppFeatures(): Promise<AppFeatures> {
  const res = await apiFetch(`${API_BASE}/api/v1/config/features`);
  if (!res.ok) throw new Error(`Failed to load app features: ${res.status}`);
  return res.json();
}

export interface PlanningConnection {
  connection_id: string;
  workspace_id: string;
  provider: string;
  name: string;
  base_url: string;
  auth_kind: string;
  auth_public: Record<string, unknown>;
  status: string;
  last_test_at: string | null;
  last_test_ok: boolean | null;
  created_at: string;
  updated_at: string;
}

export interface PlanningModelSummary {
  id: string;
  name: string;
  description?: string;
}

export interface PlanningModelMetadata {
  modelId: string;
  modelName: string;
  dimensions: Array<{
    id: string;
    name: string;
    type: string;
    members: Array<{
      id: string;
      name: string;
      parentId: string | null;
      isLeaf: boolean;
      ordinal: number;
      sign?: number;
    }>;
  }>;
  measures: Array<{ id: string; name: string; formula?: string }>;
}

export interface MappingPreviewMeasure {
  id: string;
  name: string;
  role: "input" | "formula_exposed" | "formula_derived_on_import";
  signage_note?: string;
}

export interface MappingPreview {
  model_id: string;
  model_name: string;
  measures: MappingPreviewMeasure[];
  account_signage: boolean;
  notes: string[];
}

export interface ImportProgress {
  phase: string;
  cells: number;
}

export interface ExternalModelSnapshot {
  snapshot_id: string;
  connection_id: string;
  status: string;
  error: string | null;
  external_model_name: string;
  external_model_id?: string;
  snapshot_version?: number;
  stats: ImportStats;
  metadata: PlanningModelMetadata | Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ImportStats {
  fact_count?: number;
  dimension_count?: number;
  measure_count?: number;
  source_aggregate_count?: number;
  error_count?: number;
  warning_count?: number;
  errors?: string[];
  warnings?: string[];
  imported_at?: string;
  progress?: ImportProgress;
  [key: string]: unknown;
}

export interface ConnectionEvent {
  event_id?: string;
  connection_id: string;
  event_type: string;
  details?: Record<string, unknown> | null;
  created_at?: string;
  timestamp?: string;
}

export async function listConnections(): Promise<{ connections: PlanningConnection[] }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections`, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to list connections");
  }
  return res.json();
}

export async function listImportSnapshots(): Promise<ExternalModelSnapshot[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/imports`, { headers: authHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to list import snapshots");
  }
  const data = await res.json();
  return Array.isArray(data) ? data : data.snapshots ?? data.imports ?? [];
}

export async function listConnectionEvents(connectionId: string): Promise<ConnectionEvent[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/${connectionId}/events`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to list connection events");
  }
  const data = await res.json();
  return Array.isArray(data) ? data : data.events ?? [];
}

export async function createConnection(body: {
  provider: string;
  name: string;
  base_url: string;
  auth_kind: string;
  auth_public?: Record<string, unknown>;
  secret: string;
}): Promise<PlanningConnection> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to create connection");
  }
  return res.json();
}

export async function updateConnection(
  id: string,
  body: Partial<{ name: string; base_url: string; auth_kind: string; auth_public: Record<string, unknown>; secret: string }>,
): Promise<PlanningConnection> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/${id}`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to update connection");
  }
  return res.json();
}

export async function deleteConnection(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to delete connection");
  }
}

export async function testPlanningConnection(id: string): Promise<{ ok: boolean; message?: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/${id}/test`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Connection test failed");
  }
  return res.json();
}

export async function testConnectionDraft(body: {
  provider: string;
  base_url: string;
  auth_kind: string;
  auth_public?: Record<string, unknown>;
  secret: string;
}): Promise<{ ok: boolean; message?: string; model_count?: number }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/test`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Connection test failed");
  }
  return res.json();
}

export async function listPlanningModels(connectionId: string): Promise<{ models: PlanningModelSummary[] }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/${connectionId}/models`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to list models");
  return res.json();
}

export async function getPlanningModelMetadata(
  connectionId: string,
  modelId: string,
): Promise<PlanningModelMetadata> {
  const res = await apiFetch(
    `${API_BASE}/api/v1/connections/${connectionId}/models/${encodeURIComponent(modelId)}/metadata`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error("Failed to load model metadata");
  return res.json();
}

export async function getModelMappingPreview(
  connectionId: string,
  modelId: string,
): Promise<MappingPreview> {
  const res = await apiFetch(
    `${API_BASE}/api/v1/connections/${connectionId}/models/${encodeURIComponent(modelId)}/mapping-preview`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to load mapping preview");
  }
  return res.json();
}

export async function importPlanningModel(
  connectionId: string,
  modelId: string,
  factQuery: Record<string, unknown> = {},
): Promise<{ snapshot_id: string }> {
  const res = await apiFetch(
    `${API_BASE}/api/v1/connections/${connectionId}/models/${encodeURIComponent(modelId)}/import`,
    {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fact_query: factQuery }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Import failed");
  }
  return res.json();
}

export async function getImportStatus(snapshotId: string): Promise<ExternalModelSnapshot> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/imports/${snapshotId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to get import status");
  return res.json();
}

export async function cancelImport(snapshotId: string): Promise<{ cancelled: boolean }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/imports/${snapshotId}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Cancel failed");
  }
  return res.json();
}

export async function refreshImport(snapshotId: string): Promise<{ snapshot_id: string }> {
  const res = await apiFetch(`${API_BASE}/api/v1/connections/imports/${snapshotId}/refresh`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Refresh failed");
  }
  return res.json();
}

export interface PortfolioDashboard {
  workspace_id: string;
  kpis: Array<{ key: string; label: string; value: number | string | null; unit?: string }>;
  recent_scenarios: Array<{
    scenario_id: string;
    name: string | null;
    status: string;
    created_at: string;
    updated_at: string;
    net_income?: number | null;
    revenue?: number | null;
    simulation_mode?: string | null;
  }>;
  status_counts: Record<string, number>;
  recent_runs: Array<{
    scenario_id: string;
    name: string | null;
    ran_at: string;
    net_income?: number | null;
  }>;
}

export async function getPortfolioDashboard(): Promise<PortfolioDashboard> {
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/dashboard`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to load dashboard");
  }
  return res.json();
}

// ── Scenario version lineage ──

export interface ScenarioVersion {
  version_id: string;
  scenario_id: string;
  workspace_id: string | null;
  label: string;
  version_number: number;
  touched_levers: unknown;
  parameters_snapshot: unknown;
  outputs: Record<string, number>;
  created_by: string | null;
  created_at: string;
}

export interface ScenarioVersionDiff {
  from: ScenarioVersion | null;
  to: ScenarioVersion | null;
  output_deltas: Record<string, { from: number | null; to: number | null; delta: number | null }>;
}

export async function listScenarioVersions(scenarioId: string): Promise<ScenarioVersion[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/scenarios/${scenarioId}/versions`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to list versions");
  }
  const data = await res.json();
  return data.versions ?? [];
}

export async function createScenarioVersion(
  scenarioId: string,
  body: { label?: string; outputs: Record<string, number> },
): Promise<ScenarioVersion> {
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/scenarios/${scenarioId}/versions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to create version");
  }
  const data = await res.json();
  return data.version;
}

export async function diffScenarioVersions(
  scenarioId: string,
  from: number,
  to: number,
): Promise<ScenarioVersionDiff> {
  const qs = new URLSearchParams({ from: String(from), to: String(to) });
  const res = await apiFetch(
    `${API_BASE}/api/v1/portfolio/scenarios/${scenarioId}/versions/diff?${qs}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to diff versions");
  }
  return res.json();
}

// ── Actuals / budget / forecast ──

export interface ActualsFact {
  fact_id: string;
  measure_id: string;
  period: string;
  version_lane: "actual" | "budget" | "forecast" | string;
  entity_key?: string | null;
  value: number | string;
  currency?: string | null;
  unit?: string | null;
  created_at?: string;
}

export interface ActualsCompareRow {
  measure_id: string;
  scenario: number | null;
  actual: number | null;
  budget: number | null;
  forecast: number | null;
  vs_actual: number | null;
  vs_budget: number | null;
  vs_forecast: number | null;
}

export async function listActuals(lane?: string): Promise<ActualsFact[]> {
  const qs = lane ? `?lane=${encodeURIComponent(lane)}` : "";
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/actuals${qs}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to load actuals");
  }
  const data = await res.json();
  return data.facts ?? [];
}

export async function createActuals(body: {
  facts: Array<{
    measure_id: string;
    period: string;
    value: number;
    version_lane?: "actual" | "budget" | "forecast";
    entity_key?: string;
    currency?: string;
    unit?: string;
  }>;
  source_kind?: "upload" | "sac" | "anaplan" | "manual";
}): Promise<{ inserted_count: number; facts: ActualsFact[] }> {
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/actuals`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to store actuals");
  }
  return res.json();
}

export async function compareActuals(
  scenarioId: string,
): Promise<{ scenario_id: string; comparison: ActualsCompareRow[] }> {
  const res = await apiFetch(`${API_BASE}/api/v1/portfolio/actuals/compare/${scenarioId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to compare actuals");
  }
  return res.json();
}

// ── Agent readiness ──

export interface AgentStatus {
  enabled: boolean;
  model_validated: boolean;
  ready: boolean;
  reasons: string[];
  showcase_agent_enabled?: boolean;
  has_validated_model?: boolean;
  has_active_user_model?: boolean;
  validated_document_kind?: string | null;
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/agent-status`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Failed to get agent status");
  }
  const data = await res.json();
  return data.agent as AgentStatus;
}

/** Stream open-ended agent progress; falls back to empty if SSE unavailable. */
export async function streamAgentReasoning(
  nlInput: string,
  scenarioId?: string,
  onProgress?: (stage: string, detail?: string) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await apiFetch(
    `${API_BASE}/api/v1/scenarios/agent/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ nl_input: nlInput, scenario_id: scenarioId }),
      signal,
    },
    180_000,
  );
  if (!res.ok || !res.body) {
    throw new Error("Agent stream unavailable");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: unknown = null;
  let streamError: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const chunk of parts) {
      const lines = chunk.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as {
          stage?: string;
          detail?: string;
          result?: unknown;
          error?: string;
        };
        if (event === "progress" && onProgress) onProgress(parsed.stage || "progress", parsed.detail);
        else if (event === "done") result = parsed.result ?? parsed;
        else if (event === "error") streamError = parsed.error || "Agent stream failed";
      } catch {
        // ignore malformed frames
      }
    }
  }
  if (streamError) throw new Error(streamError);
  return result;
}

// ── Chat conversation persistence ──

export interface StoredMessageMetadata {
  thinking?: {
    thinking: string;
    intent: string;
    assumptions: string[];
    second_order_effects: string[];
    duration_ms: number;
  };
  agentTrace?: Array<{ tool: string; input: unknown; output: unknown }>;
  causalChain?: Array<{
    step: string;
    detail?: string;
    kind?: "decomposition" | "research" | "levers" | "preview" | "other";
  }>;
  agentConfidence?: number;
  agentCitations?: Array<{ source: string; snippet?: string; url?: string }>;
  previewPl?: Record<string, number>;
  previewReconciliation?: { reconciled: boolean; max_abs_diff: number; message?: string };
  constraintViolations?: Array<{ lever: string; reason: string }>;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  metadata: StoredMessageMetadata | null;
  created_at: string;
}

export interface StoredConversation {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string;
  scenario_id: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface StoredConversationWithMessages extends StoredConversation {
  messages: StoredMessage[];
}

/** List conversations in the active workspace, most-recently-updated first. */
export async function listStoredConversations(): Promise<StoredConversation[]> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations`);
  if (!res.ok) throw new Error("Failed to list conversations");
  const data = await res.json();
  return data.conversations ?? [];
}

export async function getStoredConversation(id: string): Promise<StoredConversationWithMessages> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to load conversation");
  return res.json();
}

export async function createStoredConversation(opts: {
  id?: string;
  title: string;
  scenario_id?: string;
  session_id?: string;
}): Promise<StoredConversation> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function updateStoredConversation(
  id: string,
  patch: { title?: string; scenario_id?: string | null; session_id?: string | null },
): Promise<StoredConversation> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update conversation");
  return res.json();
}

export async function appendStoredMessage(
  conversationId: string,
  message: {
    id?: string;
    role: "user" | "assistant";
    content: string;
    timestamp?: string;
    metadata?: StoredMessageMetadata;
  },
): Promise<StoredMessage> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
  if (!res.ok) throw new Error("Failed to persist message");
  return res.json();
}

export async function deleteStoredConversation(id: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/api/v1/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete conversation");
}

export async function deleteStoredConversations(ids: string[]): Promise<{ deleted: string[] }> {
  if (ids.length === 0) return { deleted: [] };
  const res = await apiFetch(`${API_BASE}/api/v1/conversations/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_ids: ids }),
  });
  if (!res.ok) throw new Error("Failed to delete conversations");
  return res.json();
}
