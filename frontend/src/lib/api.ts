const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const ACCESS_KEY = "sm_access_token";
const REFRESH_KEY = "sm_refresh_token";
const WORKSPACE_KEY = "sm_workspace_id";

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
  return storage()?.getItem(ACCESS_KEY) ?? null;
}

export function getRefreshToken(): string | null {
  return storage()?.getItem(REFRESH_KEY) ?? null;
}

export function setTokens(accessToken: string, refreshToken: string): void {
  const s = storage();
  if (!s) return;
  s.setItem(ACCESS_KEY, accessToken);
  s.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens(): void {
  const s = storage();
  if (!s) return;
  s.removeItem(ACCESS_KEY);
  s.removeItem(REFRESH_KEY);
}

export function isAuthenticated(): boolean {
  return !!getAccessToken();
}

let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: refresh }),
        });
        if (!res.ok) {
          clearTokens();
          return false;
        }
        const data = await res.json();
        setTokens(data.access_token, data.refresh_token);
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

/** fetch with a timeout, distinguishing "server took too long" from other network errors. */
async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Respect a caller-supplied signal too (e.g. component unmount cancellation).
  if (init.signal) {
    init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal });
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

/** Authenticated fetch: Bearer token + workspace header, timeout, 401 → refresh → retry → login redirect. */
export async function apiFetch(input: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  let res = await fetchWithTimeout(input, { ...init, headers: buildAuthHeaders(init) }, timeoutMs);
  if (res.status === 401 && !input.includes("/api/v1/auth/")) {
    const ok = await tryRefresh();
    if (ok) {
      res = await fetchWithTimeout(input, { ...init, headers: buildAuthHeaders(init) }, timeoutMs);
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
        res = await fetchWithTimeout(input, { ...init, headers: buildAuthHeaders(init) }, timeoutMs);
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

export interface FollowUpQuestion {
  id: string;
  question: string;
  options: { label: string; value: string }[];
  allow_custom?: boolean;
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
}

export interface StoredParameter {
  parameter_id: string;
  extracted_name: string;
  mapped_variable_id: string;
  base_value: number | null;
  scenario_value: number;
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
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function refineScenario(
  scenarioId: string,
  answers: { question_id: string; answer: string }[]
): Promise<ParseScenarioResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
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
  return data.parameters;
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
  refresh_token: string;
  expires_in: number;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Login failed");
  }
  const data = await res.json();
  setTokens(data.access_token, data.refresh_token);
  return data;
}

export async function register(email: string, password: string, name?: string): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Registration failed");
  }
  const data = await res.json();
  if (data.access_token) setTokens(data.access_token, data.refresh_token);
  return data;
}

export async function logout(): Promise<void> {
  const refresh = getRefreshToken();
  try {
    if (refresh) {
      await fetch(`${API_BASE}/api/v1/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
    }
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
  seed?: number
): Promise<MonteCarloResult> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/monte-carlo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iterations, distributions, correlations, seed }),
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
  qa_report?: QAReport | null;
  reflection_log?: ReflectionStep[];
}

export async function generateBusinessAnalysis(scenarioId: string): Promise<BusinessInsight> {
  const res = await apiFetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/business-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Business analysis failed");
  }
  return res.json();
}

// ── Documents (RAG / Talk-to-Document) ──

export interface DocumentRecord {
  document_id: string;
  name: string;
  original_filename: string;
  file_type: string;
  document_kind?: "spreadsheet_model" | "document_text";
  validation_status?: "processing" | "needs_validation" | "ready";
  workbook_graph?: Record<string, unknown> | null;
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

export async function queryDocument(documentId: string, question: string): Promise<RAGResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/${documentId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Query failed: ${res.status}`);
  }
  return res.json();
}

export async function queryAllDocuments(question: string): Promise<RAGResponse> {
  const res = await apiFetch(`${API_BASE}/api/v1/documents/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || `Query failed: ${res.status}`);
  }
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
  validation_status?: "processing" | "needs_validation" | "ready";
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
  currency: string;
  currency_unit: string;
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
  model_intelligence?: { document_id: string; validation_status: "processing" | "needs_validation" | "ready" } | null;
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

export async function validateModelSchema(documentId?: string): Promise<{ validated: boolean; document_id: string; validation_status: "ready" }> {
  const res = await apiFetch(`${API_BASE}/api/v1/context/model/validate`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(documentId ? { document_id: documentId } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error || "Validation failed");
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
