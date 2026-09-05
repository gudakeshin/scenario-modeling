import test from "node:test";
import assert from "node:assert/strict";
import { AnaplanClient, type FetchLike } from "./client.js";
import { streamFactPages } from "./cellData.js";
import { parseCsv } from "./csv.js";
import type { PlanningModelMetadata } from "../types.js";

const meta: PlanningModelMetadata = {
  modelId: "model::module",
  modelName: "Finance · P&L",
  dimensions: [
    {
      id: "time",
      source_id: "Time",
      name: "Time",
      type: "time",
      members: [{ id: "q1", source_id: "q1", name: "Q1", parentId: null, isLeaf: true, sign: 1, ordinal: 0 }],
      hierarchies: [],
    },
    {
      id: "versions",
      source_id: "Versions",
      name: "Versions",
      type: "version",
      members: [{ id: "budget", source_id: "budget", name: "Budget", parentId: null, isLeaf: true, sign: 1, ordinal: 0 }],
      hierarchies: [],
    },
    {
      id: "account",
      source_id: "account-list",
      name: "Account",
      type: "account",
      members: [
        { id: "total", source_id: "total", name: "Total", parentId: null, isLeaf: false, sign: 1, ordinal: 0 },
        { id: "revenue_domestic", source_id: "rev-dom", name: "Revenue, Domestic", parentId: "total", isLeaf: true, sign: 1, ordinal: 1 },
      ],
      hierarchies: [],
    },
  ],
  measures: [{ id: "amount", source_id: "li-amount", name: "Amount", aggregation: "sum" }],
};

test("parseCsv handles quoted commas, escaped quotes, and newlines", () => {
  assert.deepEqual(
    parseCsv('a,b\n"x,y","line 1\nline 2"\n"""quoted""",z'),
    [["a", "b"], ["x,y", "line 1\nline 2"], ['"quoted"', "z"]],
  );
});

test("streamFactPages maps columns, filters, aggregates, and deletes request", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  let pollCount = 0;
  const fetchStub: FetchLike = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST") {
      return new Response(JSON.stringify({
        viewReadRequest: { requestId: "read-1", requestState: "IN_PROGRESS" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/read-1")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        viewReadRequest: { requestId: "read-1", requestState: "COMPLETE", availablePages: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/pages/0")) {
      return new Response(
        'Time,Versions,Account,Line Items,Value\nQ1,Budget,"Revenue, Domestic",Amount,"1,250"\n',
        { status: 200, headers: { "content-type": "text/csv" } },
      );
    }
    if (url.endsWith("/pages/1")) {
      return new Response(
        "Time,Versions,Account,Line Items,Value\nQ1,Budget,Total,Amount,1250\n",
        { status: 200, headers: { "content-type": "text/csv" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike;
  const client = new AnaplanClient({
    auth: { kind: "api_key", apiKey: "token" },
    fetchImpl: fetchStub,
  });
  const aggregates: Array<{ measure_id: string; member_key: string; value: number }> = [];
  const pages = [];
  for await (const page of streamFactPages(
    client,
    "https://api.anaplan.com/2/0/models/model",
    "module",
    {
      timeMemberIds: ["q1"],
      versionMemberId: "budget",
      measureIds: ["amount"],
    },
    meta,
    {
      dimensionAliases: { time: "time", versions: "versions", account: "account" },
      measureAliases: { amount: "amount" },
    },
    { pollIntervalMs: 1, pollTimeoutMs: 100 },
    (aggregate) => aggregates.push(aggregate),
  )) {
    pages.push(page);
  }

  assert.equal(pollCount, 1);
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].rows, [{
    measureId: "amount",
    memberKey: "q1|budget|revenue_domestic",
    value: 1250,
  }]);
  assert.equal(pages[1].rows.length, 0);
  assert.deepEqual(aggregates, [{
    measure_id: "amount",
    member_key: "q1|budget|total",
    value: 1250,
  }]);
  assert.ok(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/read-1")));
});

test("AnaplanClient re-authenticates once after 401", async () => {
  let authenticationCount = 0;
  let apiCount = 0;
  const fetchStub: FetchLike = (async (input) => {
    const url = String(input);
    if (url.includes("token/authenticate")) {
      authenticationCount += 1;
      return new Response(JSON.stringify({
        tokenInfo: { tokenValue: `token-${authenticationCount}`, expiresAt: Date.now() + 2_000_000 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    apiCount += 1;
    if (apiCount === 1) return new Response("expired", { status: 401 });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  const client = new AnaplanClient({
    auth: {
      kind: "oauth2_client_credentials",
      tokenUrl: "https://auth.anaplan.com/token/authenticate",
      clientId: "user",
      clientSecret: "password",
    },
    fetchImpl: fetchStub,
  });
  assert.deepEqual(await client.fetchJson("https://api.anaplan.com/2/0/users/me"), { ok: true });
  assert.equal(authenticationCount, 2);
});

test("AnaplanClient retries 429 using Retry-After", async () => {
  let count = 0;
  const fetchStub: FetchLike = (async () => {
    count += 1;
    if (count === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;
  const client = new AnaplanClient({
    auth: { kind: "api_key", apiKey: "token" },
    fetchImpl: fetchStub,
    maxRetries: 1,
  });
  assert.deepEqual(await client.fetchJson("https://api.anaplan.com/test"), { ok: true });
  assert.equal(count, 2);
});
