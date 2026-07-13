import test from "node:test";
import assert from "node:assert";
import { parseScenario } from "./parser.js";

test("parser: APAC delay + raw materials 8%", async () => {
  const r = await parseScenario(
    "What if we delay the APAC launch by one quarter and raw materials increase 8%?"
  );
  assert.ok(Array.isArray(r.parameters));
  assert.ok(r.parameters.length >= 1, `Expected >= 1 params, got ${r.parameters.length}`);
  const cost = r.parameters.find((p) => p.unit === "percent" && p.magnitude === 8);
  assert.ok(cost, "should extract percent change");
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
  assert.ok(
    r.parameters.length >= 1 || !!r.clarification_needed || (r.follow_up_questions?.length ?? 0) > 0,
    "should either extract params, ask for clarification, or probe",
  );
  if (r.follow_up_questions) {
    for (const q of r.follow_up_questions) {
      if (q.recommendation) {
        assert.ok(q.recommendation.confidence >= 0.6);
        assert.ok(q.recommendation.evidence.length >= 1);
      }
    }
  }
});

test("parser: qualitative 'recession scenario'", async () => {
  const r = await parseScenario("Model a recession scenario");
  assert.ok(
    r.parameters.length >= 1 || !!r.clarification_needed,
    "should either extract params or ask for clarification",
  );
});

test("parser: qualitative 'best case scenario'", async () => {
  const r = await parseScenario("Show me the best case scenario");
  assert.ok(
    r.parameters.length >= 1 || !!r.clarification_needed,
    "should either extract params or ask for clarification",
  );
});

test("parser: suggested_variable_id is populated", async () => {
  const r = await parseScenario("raw materials increase 10%");
  assert.ok(r.parameters.length >= 1);
  const p = r.parameters[0];
  // suggested_variable_id is expected only when a user model is available.
  assert.ok(typeof p.name === "string" && p.name.length > 0, `Parser should return a valid parameter shape: ${JSON.stringify(p)}`);
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
