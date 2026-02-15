const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

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

export interface ComparisonRow {
  metric: string;
  base: number;
  scenarios: { scenario_id: string; name: string | null; value: number; delta: number; delta_pct: number | null }[];
}

export interface ComparisonResult {
  metrics: ComparisonRow[];
  assumption_diff: { parameter: string; base_value: string; scenarios: { scenario_id: string; name: string | null; value: string }[] }[];
  key_callouts: { label: string; base: number; scenario: number; delta: number; delta_pct: number | null }[];
}

// ── Scenarios ──

export async function parseScenario(nlInput: string): Promise<ParseScenarioResponse> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios`, {
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
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/refine`, {
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
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/parameters`);
  if (!res.ok) throw new Error("Failed to get parameters");
  const data = await res.json();
  return data.parameters;
}

export async function updateParameter(
  scenarioId: string,
  paramId: string,
  updates: { scenario_value?: number; status?: string }
): Promise<StoredParameter> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/parameters/${paramId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update parameter");
  return res.json();
}

export async function approveScenario(scenarioId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/approve`, {
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
}

export async function getBaseCase(): Promise<{ pl: Record<string, number>; all_variables: Record<string, number> }> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/base-case`);
  if (!res.ok) throw new Error("Failed to get base case");
  return res.json();
}

export async function runScenario(scenarioId: string): Promise<SimulationResult> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/run`, {
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
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/narrative`, {
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
  const res = await fetch(`${API_BASE}/api/v1/scenarios/compare`, {
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
  const res = await fetch(`${API_BASE}/api/v1/scenarios`);
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
  const res = await fetch(`${API_BASE}/api/v1/audit?${qs.toString()}`);
  if (!res.ok) throw new Error("Failed to get audit trail");
  return res.json();
}

// ── User Context ──

/** Cached user identity for authenticated API calls. Falls back to /me endpoint. */
let _cachedUserId: string | null = null;

async function getUserId(): Promise<string> {
  if (_cachedUserId) return _cachedUserId;
  try {
    const user = await getCurrentUser();
    _cachedUserId = user.email; // Use email as the portable identifier
    return _cachedUserId;
  } catch {
    return ""; // Let the backend use its own default
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  // Use cached value synchronously; the initial call populates it
  const headers: Record<string, string> = {};
  if (_cachedUserId) headers["x-user-id"] = _cachedUserId;
  if (extra) Object.assign(headers, extra);
  return headers;
}

/** Initialize user context — call once at app boot */
export async function initUserContext(): Promise<void> {
  await getUserId();
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
  const res = await fetch(`${API_BASE}/api/v1/users/me`);
  if (!res.ok) throw new Error("Failed to get user profile");
  return res.json();
}

export async function listUsers(): Promise<UserProfile[]> {
  const userId = await getUserId();
  const res = await fetch(`${API_BASE}/api/v1/users`, {
    headers: { "x-user-id": userId },
  });
  if (!res.ok) throw new Error("Failed to list users");
  return res.json();
}

export async function updateUserRole(userId: string, role: string): Promise<UserProfile> {
  const currentUser = await getUserId();
  const res = await fetch(`${API_BASE}/api/v1/users/${userId}/role`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-user-id": currentUser },
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
  const currentUser = await getUserId();
  const res = await fetch(`${API_BASE}/api/v1/users/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-user-id": currentUser },
    body: JSON.stringify({ scenario_id: scenarioId, shared_with: sharedWith, permission }),
  });
  if (!res.ok) throw new Error("Failed to share scenario");
  return res.json();
}

export async function getShares(scenarioId: string): Promise<SharingRecord[]> {
  const currentUser = await getUserId();
  const res = await fetch(`${API_BASE}/api/v1/users/shares/${scenarioId}`, {
    headers: { "x-user-id": currentUser },
  });
  if (!res.ok) throw new Error("Failed to list shares");
  return res.json();
}

export async function revokeShare(sharingId: string): Promise<void> {
  const currentUser = await getUserId();
  const res = await fetch(`${API_BASE}/api/v1/users/share/${sharingId}`, {
    method: "DELETE",
    headers: { "x-user-id": currentUser },
  });
  if (!res.ok) throw new Error("Failed to revoke share");
}

// ── PowerPoint Export ──

export function getPptxExportUrl(scenarioId: string): string {
  return `${API_BASE}/api/v1/scenarios/${scenarioId}/export/pptx`;
}

/**
 * Download a file via fetch (sends auth headers), then trigger browser download.
 * Works for Excel, CSV, and PPTX exports that require x-user-id header.
 */
export async function downloadWithAuth(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { headers: authHeaders() });
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
  p10: number;
  p50: number;
  p90: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
}

export interface MonteCarloResult {
  iterations: number;
  metrics: Record<string, PercentileResult>;
  distributions: Record<string, number[]>;
  fan_chart: Record<string, { p10: number; p25: number; p50: number; p75: number; p90: number }>;
}

export async function runMonteCarlo(
  scenarioId: string,
  iterations = 1000,
  distributions: { variable_id: string; type: string; base_value: number; stddev?: number; min?: number; max?: number }[] = []
): Promise<MonteCarloResult> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/monte-carlo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iterations, distributions }),
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
}

export interface SensitivityResult {
  target_metric: string;
  swing_pct: number;
  base_metric_value: number;
  bars: TornadoBar[];
}

export async function runSensitivity(
  scenarioId: string,
  targetMetric = "net_income",
  swingPct = 20
): Promise<SensitivityResult> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/sensitivity`, {
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
  const res = await fetch(`${API_BASE}/api/v1/templates${qs}`);
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
  const res = await fetch(`${API_BASE}/api/v1/templates/from-scenario/${scenarioId}`, {
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
  const res = await fetch(`${API_BASE}/api/v1/templates/${templateId}/clone`, {
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

export interface BusinessInsight {
  headline: string;
  implications: BusinessImplication[];
  risks: BusinessRisk[];
  recommendations: BusinessRecommendation[];
  decision_context: string;
  confidence_note: string;
}

export async function generateBusinessAnalysis(scenarioId: string): Promise<BusinessInsight> {
  const res = await fetch(`${API_BASE}/api/v1/scenarios/${scenarioId}/business-analysis`, {
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
  const res = await fetch(`${API_BASE}/api/v1/documents/upload`, {
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
  const res = await fetch(`${API_BASE}/api/v1/documents`);
  if (!res.ok) throw new Error("Failed to list documents");
  const data = await res.json();
  return data.documents;
}

export async function queryDocument(documentId: string, question: string): Promise<RAGResponse> {
  const res = await fetch(`${API_BASE}/api/v1/documents/${documentId}/query`, {
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
  const res = await fetch(`${API_BASE}/api/v1/documents/query`, {
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
  const res = await fetch(`${API_BASE}/api/v1/documents/${documentId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to delete document");
}

export async function checkQdrantHealth(): Promise<{ qdrant: string; url: string }> {
  const res = await fetch(`${API_BASE}/api/v1/documents/health/qdrant`);
  if (!res.ok) throw new Error("Qdrant health check failed");
  return res.json();
}

// ── Sessions (Conversational Follow-up) ──

export async function createSession(scenarioId: string): Promise<{ session_id: string; scenario_id: string }> {
  const res = await fetch(`${API_BASE}/api/v1/sessions`, {
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
  const res = await fetch(`${API_BASE}/api/v1/sessions/${sessionId}/follow-up`, {
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
