/**
 * SAC contract unit tests — CSDL, filters, paging, leaf/aggregate split.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsdl } from "./csdlParser.js";
import { buildFactFilter } from "./filterBuilder.js";
import { streamFactPages } from "./factData.js";
import { mapContractToMetadata } from "./mapToPlanning.js";
import { ODataClient } from "./odataClient.js";
import { SacConnector } from "../sacConnector.js";
import type { ConnectionCredentials, PlanningModelMetadata } from "../types.js";
import type { PlanningDimension } from "../types.js";

const FIX = join(process.cwd(), "src/tests/fixtures/sac");

function load(name: string): string {
  return readFileSync(join(FIX, name), "utf8");
}

function loadJson(name: string): unknown {
  return JSON.parse(load(name));
}

test("parseCsdl: classic account model has ordered keys and SignedData measure", () => {
  const contract = parseCsdl(load("metadata_classic_account.xml"), "BusinessPlanning");
  assert.deepEqual(contract.dimensionOrder, ["Region", "Account", "Time", "Version"]);
  assert.equal(contract.measures[0].sourceProperty, "SignedData");
  assert.equal(contract.dimensions.find((d) => d.propertyName === "Account")?.semanticType, "account");
  assert.ok(contract.rawCsdlHash.length === 64);
});

test("filterBuilder: expands parent EMEA to leaf source ids and escapes quotes", () => {
  const contract = parseCsdl(load("metadata_classic_account.xml"), "BusinessPlanning");
  const dims: PlanningDimension[] = [
    {
      id: "region",
      source_id: "Region",
      name: "Region",
      type: "generic",
      members: [
        { id: "world", source_id: "World", name: "World", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
        { id: "emea", source_id: "EMEA", name: "EMEA", parentId: "world", isLeaf: false, sign: 1, ordinal: 1 },
        { id: "uk", source_id: "UK", name: "UK", parentId: "emea", isLeaf: true, sign: 1, ordinal: 2 },
        { id: "de", source_id: "DE", name: "DE", parentId: "emea", isLeaf: true, sign: 1, ordinal: 3 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["world"] }],
    },
    {
      id: "version",
      source_id: "Version",
      name: "Version",
      type: "version",
      members: [
        { id: "actual", source_id: "Actual", name: "Actual", parentId: null, isLeaf: true, sign: 1, ordinal: 0 },
        { id: "o_brien", source_id: "O'Brien", name: "O'Brien", parentId: null, isLeaf: true, sign: 1, ordinal: 1 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["actual"] }],
    },
  ];
  const meta = mapContractToMetadata(contract, [
    ...dims,
    {
      id: "account",
      source_id: "Account",
      name: "Account",
      type: "account",
      members: [],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: [] }],
    },
    {
      id: "time",
      source_id: "Time",
      name: "Time",
      type: "time",
      members: [],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: [] }],
    },
  ]);
  const filter = buildFactFilter(
    { filters: { region: ["emea"] }, versionMemberId: "o_brien" },
    contract,
    meta,
  );
  assert.ok(filter);
  assert.match(filter!, /Region eq 'UK'/);
  assert.match(filter!, /Region eq 'DE'/);
  assert.match(filter!, /Version eq 'O''Brien'/);
});

test("odataClient: follows nextLink and refreshes on 401", async () => {
  let tokenCalls = 0;
  let factCalls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("token")) {
      tokenCalls += 1;
      return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("FactData") && factCalls === 0) {
      factCalls += 1;
      // First call unauthorized → client clears token and retries
      if ((init?.headers as Record<string, string>)?.Authorization === "Bearer t1") {
        return new Response("unauthorized", { status: 401 });
      }
    }
    if (url.includes("FactData")) {
      factCalls += 1;
      if (url.includes("skiptoken") || factCalls > 2) {
        return new Response(JSON.stringify(loadJson("factdata_p2.json")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(loadJson("factdata_p1.json")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const client = new ODataClient({
    auth: {
      kind: "oauth2_client_credentials",
      tokenUrl: "https://example.com/token",
      clientId: "id",
      clientSecret: "secret",
    },
    fetchImpl,
    defaultPageSize: 5,
  });

  const pages: unknown[][] = [];
  for await (const page of client.paginateJson("https://example.com/FactData?$top=5")) {
    pages.push(page.value);
  }
  assert.equal(pages.length, 2);
  assert.ok(tokenCalls >= 2);
});

test("streamFactPages: leaf rows vs source aggregates", async () => {
  const contract = parseCsdl(load("metadata_classic_account.xml"), "BusinessPlanning");
  const meta: PlanningModelMetadata = mapContractToMetadata(contract, [
    {
      id: "region",
      source_id: "Region",
      name: "Region",
      type: "generic",
      members: [
        { id: "emea", source_id: "EMEA", name: "EMEA", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
        { id: "uk", source_id: "UK", name: "UK", parentId: "emea", isLeaf: true, sign: 1, ordinal: 1 },
        { id: "de", source_id: "DE", name: "DE", parentId: "emea", isLeaf: true, sign: 1, ordinal: 2 },
        { id: "us", source_id: "US", name: "US", parentId: null, isLeaf: true, sign: 1, ordinal: 3 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["emea", "us"] }],
    },
    {
      id: "account",
      source_id: "Account",
      name: "Account",
      type: "account",
      members: [
        { id: "revenue", source_id: "Revenue", name: "Revenue", parentId: null, isLeaf: true, sign: -1, ordinal: 0 },
        { id: "cogs", source_id: "COGS", name: "COGS", parentId: null, isLeaf: true, sign: 1, ordinal: 1 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["revenue", "cogs"] }],
    },
    {
      id: "time",
      source_id: "Time",
      name: "Time",
      type: "time",
      members: [
        { id: "2024_01", source_id: "2024.01", name: "2024-01", parentId: null, isLeaf: true, sign: 1, ordinal: 0 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["2024_01"] }],
    },
    {
      id: "version",
      source_id: "Version",
      name: "Version",
      type: "version",
      members: [
        { id: "actual", source_id: "Actual", name: "Actual", parentId: null, isLeaf: true, sign: 1, ordinal: 0 },
      ],
      hierarchies: [{ id: "default", name: "Default", rootMemberIds: ["actual"] }],
    },
  ]);

  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("skiptoken") || url.includes("page2")) {
      return new Response(JSON.stringify(loadJson("factdata_p2.json")), { status: 200 });
    }
    return new Response(JSON.stringify(loadJson("factdata_p1.json")), { status: 200 });
  };
  const client = new ODataClient({
    auth: { kind: "api_key", apiKey: "x" },
    fetchImpl,
    defaultPageSize: 5,
  });

  const leaves: string[] = [];
  const aggs: string[] = [];
  for await (const page of streamFactPages(
    client,
    "https://example.com/providers/sac/BusinessPlanning",
    {},
    contract,
    meta,
    (a) => aggs.push(a.member_key),
  )) {
    for (const r of page.rows) leaves.push(r.memberKey);
  }
  assert.ok(leaves.some((k) => k.startsWith("uk|")));
  assert.ok(aggs.some((k) => k.startsWith("emea|")));
  assert.ok(!leaves.some((k) => k.startsWith("emea|")));
});

test("SacConnector listModels uses Administration Providers", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("token")) {
      return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("/Providers")) {
      return new Response(JSON.stringify(loadJson("administration_providers.json")), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };
  const creds: ConnectionCredentials = {
    connectionId: "c1",
    provider: "sap_sac",
    baseUrl: "https://example.sapanalytics.cloud",
    auth: {
      kind: "oauth2_client_credentials",
      tokenUrl: "https://example.com/token",
      clientId: "id",
      clientSecret: "secret",
    },
  };
  const connector = new SacConnector(creds, fetchImpl);
  const models = await connector.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "BusinessPlanning");
});
