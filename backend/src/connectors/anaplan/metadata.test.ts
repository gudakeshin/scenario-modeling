import test from "node:test";
import assert from "node:assert/strict";
import { AnaplanClient, type FetchLike } from "./client.js";
import {
  encodeCompositeModelId,
  parseCompositeModelId,
} from "./contract.js";
import { buildModuleMetadata } from "./metadata.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const fetchStub: FetchLike = (async (input) => {
  const url = String(input);
  if (url.includes("/lineItems")) {
    return json({
      items: [
        {
          id: "li-revenue",
          name: "Revenue",
          format: { dataType: "NUMBER", currencyCode: "USD" },
          summary: "Sum",
          appliesTo: [{ id: "account-list", name: "Account" }],
          timeScale: "Month",
          versions: true,
        },
        {
          id: "li-cost",
          name: "Cost",
          format: { dataType: "NUMBER" },
          summary: "Average",
          appliesTo: [{ id: "account-list", name: "Account" }],
          timeScale: "Month",
          versions: true,
          formula: "Revenue / 2",
        },
        {
          id: "li-unsafe",
          name: "Unsafe",
          format: { dataType: "NUMBER" },
          summary: "Closing Balance",
          appliesTo: [{ id: "account-list", name: "Account" }],
          timeScale: "Month",
          versions: true,
          formula: "SUM(Account.Revenue)",
        },
        { id: "li-note", name: "Note", format: { dataType: "TEXT" } },
      ],
    });
  }
  if (url.endsWith("/views/module-2")) {
    return json({
      dimensions: {
        pages: [{ id: "Time", name: "Time" }],
        rows: [{ id: "Versions", name: "Versions" }],
        columns: [{ id: "account-list", name: "Account" }],
      },
    });
  }
  if (url.includes("/lists/account-list/items")) {
    return json({
      items: [
        { id: "total", name: "Total", isLeaf: false },
        { id: "revenue", name: "Revenue", parentId: "total" },
      ],
    });
  }
  if (url.includes("/dimensions/Time/items")) {
    return json({ items: [{ id: "q1", name: "Q1" }, { id: "q2", name: "Q2" }] });
  }
  if (url.includes("/dimensions/Versions/items")) {
    return json({ items: [{ id: "budget", name: "Budget" }] });
  }
  return new Response("not found", { status: 404 });
}) as FetchLike;

test("Anaplan composite ids encode and parse", () => {
  const id = encodeCompositeModelId("model-1", "module-2");
  assert.equal(id, "model-1::module-2");
  assert.deepEqual(parseCompositeModelId(id), { modelId: "model-1", moduleId: "module-2" });
  assert.throws(() => parseCompositeModelId("model-only"));
});

test("buildModuleMetadata orders dimensions and gates formulas", async () => {
  const client = new AnaplanClient({
    auth: { kind: "api_key", apiKey: "token" },
    fetchImpl: fetchStub,
  });
  const { meta, columnMaps } = await buildModuleMetadata(
    client,
    "https://api.anaplan.com/2/0/models/model-1",
    {
      modelId: "model-1",
      moduleId: "module-2",
      modelName: "Finance",
      moduleName: "P&L",
    },
  );

  assert.deepEqual(meta.dimensions.map((dimension) => dimension.type), ["time", "version", "account"]);
  assert.deepEqual(meta.dimensions.map((dimension) => dimension.id), ["time", "versions", "account"]);
  assert.equal(meta.dimensions[0].members.length, 2);
  assert.equal(meta.dimensions[2].members[0].isLeaf, false);
  assert.deepEqual(meta.measures.map((measure) => measure.aggregation), ["sum", "avg", "last"]);
  assert.equal(meta.measures[0].unit, "USD");
  assert.equal(meta.measures[1].formula, "revenue / 2");
  assert.equal(meta.measures[2].formula, undefined);
  assert.equal(meta.measures[2].attributes?.source_formula, "SUM(Account.Revenue)");
  assert.equal(columnMaps.measureAliases.revenue, "revenue");
});
