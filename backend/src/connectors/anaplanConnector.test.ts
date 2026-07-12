import test from "node:test";
import assert from "node:assert/strict";
import { AnaplanConnector } from "./anaplanConnector.js";
import type { ConnectionCredentials } from "./types.js";

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
});

test("AnaplanConnector testConnection ok in mock mode", async () => {
  const c = new AnaplanConnector(mockCreds());
  const t = await c.testConnection();
  assert.equal(t.ok, true);
  assert.match(t.message || "", /mock/i);
});
