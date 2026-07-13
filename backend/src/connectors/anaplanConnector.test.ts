import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnaplanConnector } from "./anaplanConnector.js";
import type { ConnectionCredentials } from "./types.js";
import type { FetchLike } from "./anaplan/client.js";

const FIXTURES = join(process.cwd(), "src/tests/fixtures/anaplan");

function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function mockCreds(): ConnectionCredentials {
  return {
    connectionId: "conn-mock",
    provider: "anaplan",
    baseUrl: "https://api.anaplan.com/2/0",
    auth: { kind: "api_key", apiKey: "" },
    authPublic: { workspace_id: "ws-mock" },
  };
}

test("AnaplanConnector enters mock mode without credentials", () => {
  const c = new AnaplanConnector(mockCreds());
  assert.equal(c.isMockMode(), true);
});

test("AnaplanConnector listModels returns stubs in mock mode", async () => {
  const c = new AnaplanConnector(mockCreds());
  const models = await c.listModels();
  assert.ok(models.length >= 1);
  assert.ok(models[0].id.startsWith("mock-"));
});

test("AnaplanConnector getModelMetadata returns dimensions/measures stubs", async () => {
  const c = new AnaplanConnector(mockCreds());
  const meta = await c.getModelMetadata("mock-anaplan-pl");
  assert.equal(meta.modelId, "mock-anaplan-pl");
  assert.ok(meta.dimensions.some((d) => d.type === "time"));
  assert.ok(meta.measures.length >= 1);
  assert.equal((meta.providerRaw as { mock?: boolean })?.mock, true);
});

test("AnaplanConnector getModelData yields rows in mock mode", async () => {
  const c = new AnaplanConnector(mockCreds());
  const pages: Array<{ rows: unknown[] }> = [];
  for await (const page of c.getModelData("mock-anaplan-pl", { pageSize: 10 })) {
    pages.push(page);
  }
  assert.equal(pages.length, 1);
  assert.ok(pages[0].rows.length >= 1);
  assert.equal((pages[0].rows[0] as { measureId: string }).measureId, "amount");
  assert.equal((pages[0].rows[0] as { memberKey: string }).memberKey, "q1|budget|revenue");
});

test("AnaplanConnector testConnection ok in mock mode", async () => {
  const c = new AnaplanConnector(mockCreds());
  const t = await c.testConnection();
  assert.equal(t.ok, true);
  assert.match(t.message || "", /mock/i);
});

test("AnaplanConnector treats mock://local as mock mode with a non-empty secret", () => {
  const creds = mockCreds();
  creds.baseUrl = "mock://local";
  creds.auth = { kind: "api_key", apiKey: "required-placeholder" };
  assert.equal(new AnaplanConnector(creds).isMockMode(), true);
});

test("AnaplanConnector lists composite modules and streams live fixture data", async () => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  const fetchStub: FetchLike = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/workspaces/ws-live/models")) {
      return json(fixtureJson("models.json"));
    }
    if (url.endsWith("/models/model-1/modules")) {
      return json(fixtureJson("modules.json"));
    }
    if (url.includes("/modules/module-1/lineItems")) {
      return json(fixtureJson("lineitems.json"));
    }
    if (url.endsWith("/views/module-1")) {
      return json(fixtureJson("view_metadata.json"));
    }
    if (url.includes("/lists/account-list/items")) {
      return json(fixtureJson("list_items.json"));
    }
    if (url.includes("/dimensions/20000000003/items")) {
      return json(fixtureJson("time_items.json"));
    }
    if (url.includes("/dimensions/20000000004/items")) {
      return json(fixtureJson("version_items.json"));
    }
    if (url.endsWith("/views/module-1/readRequests") && method === "POST") {
      return json(fixtureJson("readrequest_complete.json"));
    }
    if (url.endsWith("/readRequests/read-1/pages/0")) {
      return new Response(fixtureText("cells_page_0.csv"), {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    if (url.endsWith("/readRequests/read-1/pages/1")) {
      return new Response(fixtureText("cells_page_1.csv"), {
        status: 200,
        headers: { "content-type": "text/csv" },
      });
    }
    if (url.endsWith("/readRequests/read-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(`unhandled ${method} ${url}`, { status: 404 });
  }) as FetchLike;
  const creds: ConnectionCredentials = {
    connectionId: "conn-live",
    provider: "anaplan",
    baseUrl: "https://api.anaplan.com/2/0",
    auth: { kind: "api_key", apiKey: "token" },
    authPublic: { workspace_id: "ws-live" },
  };
  const connector = new AnaplanConnector(creds, fetchStub);
  const models = await connector.listModels();
  assert.deepEqual(models.map((model) => model.id), ["model-1::module-1"]);
  const metadata = await connector.getModelMetadata(models[0].id);
  assert.deepEqual(metadata.dimensions.map((dimension) => dimension.id), ["time", "versions", "account"]);

  const pages = [];
  for await (const page of connector.getModelData(models[0].id, {})) pages.push(page);
  assert.deepEqual(pages[0].rows, [{
    measureId: "amount",
    memberKey: "q1|budget|revenue_domestic",
    value: 1250,
  }]);
  const cachedMetadata = await connector.getModelMetadata(models[0].id);
  assert.deepEqual(cachedMetadata.source_aggregates, [{
    measure_id: "amount",
    member_key: "q1|budget|total",
    value: 1250,
  }]);
});
