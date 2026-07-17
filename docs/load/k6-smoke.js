import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost:4000";
const MODEL = open(__ENV.MODEL_FILE || "../../sample_data/Wonder_Cement_Scenario_Model_FY2025.xlsx", "b");

export const options = {
  vus: Number(__ENV.VUS || 2),
  iterations: Number(__ENV.ITERATIONS || 4),
  thresholds: {
    http_req_failed: ["rate<0.05"],
    // Includes synchronous context construction and scenario execution.
    http_req_duration: ["p(95)<120000"],
  },
};

function tryLogin(email, password) {
  const response = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: { "Content-Type": "application/json" },
      responseCallback: http.expectedStatuses(200, 401),
    },
  );
  return response;
}

function login(email, password) {
  const response = tryLogin(email, password);
  if (!check(response, { "login succeeds": (r) => r.status === 200 })) {
    throw new Error(`Login failed for ${email}: ${response.status} ${response.body}`);
  }
  return {
    token: response.json("access_token"),
    userId: response.json("user.user_id"),
  };
}

function headers(token, workspaceId) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Workspace-Id": workspaceId,
    "Content-Type": "application/json",
  };
}

export function setup() {
  const analystEmail = __ENV.ANALYST_EMAIL || "dev@example.com";
  const analystPassword = __ENV.ANALYST_PASSWORD || "changeme-admin-password";
  const approverEmail = __ENV.APPROVER_EMAIL || "approver@example.com";
  const approverPassword = __ENV.APPROVER_PASSWORD || "changeme-approver-password";
  const analyst = login(analystEmail, analystPassword);
  const workspaceResponse = http.get(`${BASE}/api/v1/workspaces`, {
    headers: { Authorization: `Bearer ${analyst.token}` },
  });
  if (workspaceResponse.status !== 200) {
    throw new Error(`Workspace listing failed: ${workspaceResponse.status} ${workspaceResponse.body}`);
  }
  const workspaceId = workspaceResponse.json("workspaces.0.workspace_id");
  if (!workspaceId) throw new Error("Analyst has no workspace");

  let approverResponse = tryLogin(approverEmail, approverPassword);
  let approverUserId;
  if (approverResponse.status === 200) {
    approverUserId = approverResponse.json("user.user_id");
  } else {
    const registration = http.post(
      `${BASE}/api/v1/auth/register`,
      JSON.stringify({
        email: approverEmail,
        password: approverPassword,
        name: "Load Smoke Approver",
        role: "approver",
      }),
      {
        headers: headers(analyst.token, workspaceId),
        responseCallback: http.expectedStatuses(201, 409),
      },
    );
    if (registration.status !== 201 && registration.status !== 409) {
      throw new Error(`Approver bootstrap failed: ${registration.status} ${registration.body}`);
    }
    approverResponse = tryLogin(approverEmail, approverPassword);
    approverUserId = approverResponse.json("user.user_id");
  }
  if (approverResponse.status !== 200) {
    throw new Error(`Approver login failed: ${approverResponse.status} ${approverResponse.body}`);
  }
  const approverToken = approverResponse.json("access_token");

  const membership = http.post(
    `${BASE}/api/v1/workspaces/${workspaceId}/members`,
    JSON.stringify({
      user_id: approverUserId,
      access_reason: "Automated pre-release load smoke maker-checker",
    }),
    { headers: headers(analyst.token, workspaceId) },
  );
  if (membership.status !== 201) {
    throw new Error(`Approver workspace grant failed: ${membership.status} ${membership.body}`);
  }

  const upload = http.post(
    `${BASE}/api/v1/documents/upload`,
    { file: http.file(MODEL, "load-smoke.xlsx") },
    { headers: { Authorization: `Bearer ${analyst.token}`, "X-Workspace-Id": workspaceId } },
  );
  if (!check(upload, { "upload accepted": (r) => r.status === 201 || r.status === 202 })) {
    throw new Error(`Upload failed: ${upload.status} ${upload.body}`);
  }
  const documentId = upload.json("document_id");
  let ingestionReady = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const status = http.get(`${BASE}/api/v1/documents/${documentId}`, {
      headers: headers(analyst.token, workspaceId),
    });
    if (status.json("status") === "ready") {
      ingestionReady = true;
      break;
    }
    if (status.json("status") === "error" || status.json("status") === "rejected") {
      throw new Error(`Ingestion failed: ${status.body}`);
    }
    sleep(2);
  }
  if (!ingestionReady) throw new Error("Ingestion did not become ready within five minutes");

  const context = http.post(`${BASE}/api/v1/context/build`, "{}", {
    headers: headers(analyst.token, workspaceId),
    timeout: "5m",
  });
  if (!check(context, { "context builds": (r) => r.status === 201 })) {
    throw new Error(`Context build failed: ${context.status} ${context.body}`);
  }
  const modelResponse = http.get(`${BASE}/api/v1/context/model`, {
    headers: headers(analyst.token, workspaceId),
  });
  if (modelResponse.status !== 200 || !modelResponse.json("model")) {
    throw new Error(`Active model lookup failed: ${modelResponse.status} ${modelResponse.body}`);
  }
  const variables = modelResponse.json("model.model_definition.variables") || [];
  const lever = variables.find((variable) =>
    variable.is_input === true || (variable.tags || []).includes("input"));
  if (!lever?.name) throw new Error("Active model has no input lever for the scenario smoke");

  return {
    analystToken: analyst.token,
    approverToken,
    workspaceId,
    leverName: lever.name,
  };
}

export default function (data) {
  const create = http.post(
    `${BASE}/api/v1/scenarios`,
    JSON.stringify({
      nl_input: `${data.leverName} increase 2%`,
      name: `k6-${__VU}-${__ITER}`,
    }),
    { headers: headers(data.analystToken, data.workspaceId), timeout: "2m" },
  );
  if (!check(create, { "scenario creates": (r) => r.status === 201 })) {
    throw new Error(`Scenario creation failed: ${create.status} ${create.body}`);
  }
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
  if (!check(approve, { "scenario approves": (r) => r.status === 200 })) {
    throw new Error(`Scenario approval failed: ${approve.status} ${approve.body}`);
  }
  const run = http.post(`${BASE}/api/v1/scenarios/${scenarioId}/run`, "{}", {
    headers: headers(data.analystToken, data.workspaceId),
    timeout: "2m",
  });
  if (!check(run, { "scenario runs": (r) => r.status === 200 })) {
    throw new Error(`Scenario run failed: ${run.status} ${run.body}`);
  }
}
