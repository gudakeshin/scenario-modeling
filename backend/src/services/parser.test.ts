import test from "node:test";
import assert from "node:assert";
import { parseScenario } from "./parser.js";

test("parser: APAC delay + raw materials 8%", async () => {
  const r = await parseScenario(
    "What if we delay the APAC launch by one quarter and raw materials increase 8%?"
  );
  assert.ok(Array.isArray(r.parameters));
  assert.ok(r.parameters.length >= 1, `Expected >= 1 params, got ${r.parameters.length}`);
  const delay = r.parameters.find((p) => p.variable_type === "timeline_shift");
  const cost = r.parameters.find((p) => p.unit === "percent");
  assert.ok(delay, "should extract timeline delay");
  assert.ok(cost, "should extract percent change");
  if (delay) {
    assert.strictEqual(delay.direction, "delay");
    assert.strictEqual(delay.unit, "quarter");
  }
  if (cost) {
    assert.ok(["increase", "decrease"].includes(cost.direction));
    assert.strictEqual(cost.magnitude, 8);
  }
});

test("parser: revenue 20% marketing 15%", async () => {
  const r = await parseScenario(
    "Scenario: Revenue increases 20% but marketing costs go up 15%"
  );
  assert.ok(r.parameters.length >= 1, `Expected >= 1 params, got ${r.parameters.length}`);
  assert.ok(
    r.parameters.some((p) => p.unit === "percent" && (p.magnitude === 20 || p.magnitude === 15)),
    "should extract 20% or 15%"
  );
});

test("parser: qualitative 'supply chain disruption'", async () => {
  const r = await parseScenario("What if there is a supply chain disruption?");
  assert.ok(r.parameters.length >= 1, "should extract params from qualitative business scenario");
  const costParam = r.parameters.find((p) => p.direction === "increase");
  assert.ok(costParam, "should interpret supply chain disruption as a cost increase");
});

test("parser: qualitative 'recession scenario'", async () => {
  const r = await parseScenario("Model a recession scenario");
  assert.ok(r.parameters.length >= 1, "should extract params from recession scenario");
  const decline = r.parameters.find((p) => p.direction === "decrease");
  assert.ok(decline, "should include a decline parameter");
});

test("parser: qualitative 'best case scenario'", async () => {
  const r = await parseScenario("Show me the best case scenario");
  assert.ok(r.parameters.length >= 1, "should extract params from best case scenario");
  const growth = r.parameters.find((p) => p.direction === "increase");
  assert.ok(growth, "should include a growth parameter");
});

test("parser: suggested_variable_id is populated", async () => {
  const r = await parseScenario("raw materials increase 10%");
  assert.ok(r.parameters.length >= 1);
  const p = r.parameters[0];
  assert.ok(p.suggested_variable_id, `Expected suggested_variable_id, got: ${JSON.stringify(p)}`);
});

test("parser: ambiguous input returns clarification", async () => {
  const r = await parseScenario("things might change");
  assert.ok(r.parameters.length === 0 || r.clarification_needed != null);
});

test("parser: empty or very short input", async () => {
  const r = await parseScenario("x");
  assert.ok(Array.isArray(r.parameters));
  assert.ok(r.parameters.length === 0);
});
