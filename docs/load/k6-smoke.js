import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:4000";
const MODEL = open(__ENV.MODEL_FILE || "../../sample_data/Wonder_Cement_Scenario_Model_FY2025.xlsx", "b");

export const options = {
  vus: Number(__ENV.VUS || 2),
  iterations: Number(__ENV.ITERATIONS || 4),
  thresholds: {
    http_req_failed: ["rate<0.05"],
    http_req_duration: ["p(95)<5000"],
  },
};

function login(email, password) {
  const response = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(response, { "login succeeds": (r) => r.status === 200 });
  return response.json("access_token");
}

function headers(token, workspaceId) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Workspace-Id": workspaceId,
    "Content-Type": "application/json",
  };
}

export function setup() {
  const analystToken = login(
    __ENV.ANALYST_EMAIL || "dev@example.com",
    __ENV.ANALYST_PASSWORD || "changeme-admin-password",
  );
  const approverToken = login(
    __ENV.APPROVER_EMAIL || "approver@example.com",
    __ENV.APPROVER_PASSWORD || "changeme-approver-password",
  );
  const workspaceResponse = http.get(`${BASE}/api/v1/workspaces`, {
    headers: { Authorization: `Bearer ${analystToken}` },
  });
  const workspaceId = workspaceResponse.json("workspaces.0.workspace_id");
  const upload = http.post(
    `${BASE}/api/v1/documents/upload`,
    { file: http.file(MODEL, "load-smoke.xlsx") },
    { headers: { Authorization: `Bearer ${analystToken}`, "X-Workspace-Id": workspaceId } },
  );
  check(upload, { "upload accepted": (r) => r.status === 201 || r.status === 202 });
  const documentId = upload.json("document_id");
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = http.get(`${BASE}/api/v1/documents/${documentId}`, {
      headers: headers(analystToken, workspaceId),
    });
    if (status.json("status") === "ready") break;
    if (status.json("status") === "error" || status.json("status") === "rejected") {
      throw new Error(`Ingestion failed: ${status.body}`);
    }
    sleep(2);
  }
  const context = http.post(`${BASE}/api/v1/context/build`, "{}", {
    headers: headers(analystToken, workspaceId),
    timeout: "5m",
  });
  check(context, { "context builds": (r) => r.status === 200 });
  return { analystToken, approverToken, workspaceId };
}

export default function (data) {
  const create = http.post(
    `${BASE}/api/v1/scenarios`,
    JSON.stringify({ nl_input: "Increase fuel cost by 2 percent", name: `k6-${__VU}-${__ITER}` }),
    { headers: headers(data.analystToken, data.workspaceId), timeout: "2m" },
  );
  check(create, { "scenario creates": (r) => r.status === 201 });
  const scenarioId = create.json("scenario_id");
  const parameters = http.get(`${BASE}/api/v1/scenarios/${scenarioId}/parameters`, {
    headers: headers(data.analystToken, data.workspaceId),
  }).json("parameters") || [];
  for (const parameter of parameters) {
    http.put(
      `${BASE}/api/v1/scenarios/${scenarioId}/parameters/${parameter.parameter_id}`,
      JSON.stringify({ status: "accepted" }),
      { headers: headers(data.analystToken, data.workspaceId) },
    );
  }
  const approve = http.post(`${BASE}/api/v1/scenarios/${scenarioId}/approve`, "{}", {
    headers: headers(data.approverToken, data.workspaceId),
  });
  check(approve, { "scenario approves": (r) => r.status === 200 });
  const run = http.post(`${BASE}/api/v1/scenarios/${scenarioId}/run`, "{}", {
    headers: headers(data.analystToken, data.workspaceId),
    timeout: "2m",
  });
  check(run, { "scenario runs": (r) => r.status === 200 });
}
