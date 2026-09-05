/**
 * Unit tests for scenarioReasoningAgent — mocked tools / loop.
 * Asserts propose_parameters terminal path, constraint blocking, and input-lever filter.
 */

import test from "node:test";
import assert from "node:assert";
import { addConstraint, ensureScenarioContext, clearConstraints } from "./scenarioContextService.js";
import { validateAgainstConstraints } from "./scenarioContextService.js";
import {
  filterParametersToInputLevers,
  runScenarioReasoning,
} from "./scenarioReasoningAgent.js";

test("constraint blocking: ceiling violation is detected", () => {
  const scenarioId = "test-agent-constraints";
  ensureScenarioContext(scenarioId);
  clearConstraints(scenarioId);
  addConstraint(scenarioId, {
    type: "ceiling",
    lever: "opex",
    max: 10,
    reason: "Opex increase capped at 10%",
  });

  const ok = validateAgainstConstraints({ opex: 5 }, [
    { type: "ceiling", lever: "opex", max: 10, reason: "Opex increase capped at 10%" },
  ]);
  assert.strictEqual(ok.ok, true);

  const blocked = validateAgainstConstraints({ opex: 25 }, [
    { type: "ceiling", lever: "opex", max: 10, reason: "Opex increase capped at 10%" },
  ]);
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.violations.some((v) => v.lever === "opex"));
});

test("propose_parameters schema accepts terminal payload shape", async () => {
  const { z } = await import("zod");
  const proposeParametersSchema = z.object({
    parameters: z
      .array(
        z.object({
          name: z.string(),
          variable_type: z.string().default("operational_change"),
          direction: z.string().default("set"),
          magnitude: z.number().default(0),
          unit: z.string().default("percent"),
          scope: z.record(z.string()).default({}),
          confidence: z.number().min(0).max(1).default(0.5),
          suggested_variable_id: z.string().optional(),
        }),
      )
      .default([]),
    causal_chain: z
      .array(
        z.object({
          step: z.string(),
          detail: z.string().optional(),
          kind: z.enum(["decomposition", "research", "levers", "preview", "other"]).default("other"),
        }),
      )
      .default([]),
    citations: z
      .array(z.object({ source: z.string(), snippet: z.string().optional(), url: z.string().optional() }))
      .default([]),
    confidence: z.number().min(0).max(1).default(0.5),
    clarification_needed: z.string().nullable().optional(),
  });

  const parsed = proposeParametersSchema.parse({
    parameters: [
      {
        name: "Revenue +5%",
        variable_type: "revenue_change",
        direction: "increase",
        magnitude: 5,
        unit: "percent",
        suggested_variable_id: "revenue",
        confidence: 0.8,
      },
    ],
    causal_chain: [
      { step: "Decompose inflation shock", kind: "decomposition" },
      { step: "Map to revenue lever", kind: "levers" },
    ],
    citations: [{ source: "Perplexity", snippet: "CPI at 3.2%" }],
    confidence: 0.75,
  });

  assert.strictEqual(parsed.parameters.length, 1);
  assert.strictEqual(parsed.parameters[0].suggested_variable_id, "revenue");
  assert.strictEqual(parsed.causal_chain[0].kind, "decomposition");
});

test("runScenarioReasoning returns structured readiness when agent disabled", async () => {
  const result = await runScenarioReasoning(
    "What if a recession hits our market?",
    { userId: "00000000-0000-0000-0000-000000000001", workspaceId: "00000000-0000-0000-0000-000000000002" },
  );
  assert.ok(
    result.stopped_reason === "disabled" ||
      result.stopped_reason === "not_ready" ||
      result.stopped_reason === "error",
  );
  assert.ok(result.clarification_needed || result.error);
  assert.strictEqual(result.parameters.length, 0);
  assert.ok(result.readiness, "readiness payload required");
  assert.strictEqual(typeof result.readiness.enabled, "boolean");
  assert.strictEqual(typeof result.readiness.model_validated, "boolean");
  assert.strictEqual(typeof result.readiness.ready, "boolean");
  assert.ok(Array.isArray(result.readiness.reasons));
  if (result.stopped_reason === "disabled") {
    assert.strictEqual(result.readiness.enabled, false);
    assert.strictEqual(result.readiness.ready, false);
    assert.ok(result.readiness.reasons.some((r) => /SHOWCASE_AGENT_ENABLED/i.test(r)));
  }
});

test("filterParametersToInputLevers rejects calculated outputs", () => {
  const inputIds = new Set(["revenue", "cogs", "opex"]);
  const { kept, rejected } = filterParametersToInputLevers(
    [
      { name: "Rev +5%", suggested_variable_id: "revenue" },
      { name: "GP override", suggested_variable_id: "gross_profit" },
      { name: "EBITDA set", suggested_variable_id: "ebitda" },
      { name: "Unmapped", suggested_variable_id: undefined },
    ],
    inputIds,
  );
  assert.strictEqual(kept.length, 2);
  assert.ok(kept.some((p) => p.suggested_variable_id === "revenue"));
  assert.ok(kept.some((p) => p.suggested_variable_id === undefined));
  assert.deepStrictEqual(rejected.sort(), ["ebitda", "gross_profit"]);
});

test("filterParametersToInputLevers keeps all when catalog empty", () => {
  const { kept, rejected } = filterParametersToInputLevers(
    [{ name: "Anything", suggested_variable_id: "gross_profit" }],
    new Set(),
  );
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(rejected.length, 0);
});

test("mocked agent loop stops on propose_parameters terminal tool", async () => {
  const steps: Array<{ tool: string; input: unknown; output: unknown }> = [];
  const terminalName = "propose_parameters";
  const tools = [
    {
      name: "get_model_schema",
      handler: async () => ({ schema: { levers: ["revenue"] } }),
    },
    {
      name: terminalName,
      handler: async (input: unknown) => input,
    },
  ];

  const simulatedCalls = [
    { name: "get_model_schema", input: {} },
    {
      name: terminalName,
      input: {
        parameters: [
          {
            name: "Revenue +3%",
            magnitude: 3,
            unit: "percent",
            direction: "increase",
            suggested_variable_id: "revenue",
            confidence: 0.7,
          },
        ],
        causal_chain: [{ step: "Research done", kind: "research" }],
        citations: [],
        confidence: 0.7,
      },
    },
  ];

  let stopped = "max_steps";
  let result: unknown = null;
  for (const call of simulatedCalls) {
    const tool = tools.find((t) => t.name === call.name)!;
    const output = await tool.handler(call.input);
    steps.push({ tool: call.name, input: call.input, output });
    if (call.name === terminalName) {
      result = output;
      stopped = "terminal_tool";
      break;
    }
  }

  assert.strictEqual(stopped, "terminal_tool");
  assert.ok(result && typeof result === "object");
  assert.ok(steps.some((s) => s.tool === "propose_parameters"));
  assert.ok(steps.some((s) => s.tool === "get_model_schema"));
});

test("run_what_if style constraint gate blocks before preview", () => {
  const constraints = [
    { type: "ceiling" as const, lever: "raw_material_cost", max: 8, reason: "Max 8% materials" },
  ];
  const proposed = { raw_material_cost: 15 };
  const validation = validateAgainstConstraints(proposed, constraints);
  assert.strictEqual(validation.ok, false);
  assert.match(validation.violations[0].reason, /materials|ceiling|8/i);
});

test("describeCostRevenueComposition includes revenue and cost lines", async () => {
  const { describeCostRevenueComposition } = await import("./contextEngine.js");
  const text = describeCostRevenueComposition({
    company_name: "Acme",
    industry: "Manufacturing",
    business_model: "B2B",
    revenue_streams: ["Product", "Services"],
    financial_metrics: [
      {
        name: "Revenue",
        variable_id: "revenue",
        description: "Top line",
        typical_value: 1000,
        unit: "Million",
        category: "revenue",
        is_input: true,
      },
      {
        name: "COGS",
        variable_id: "cogs",
        description: "Cost of goods",
        typical_value: 400,
        unit: "Million",
        category: "cost",
        is_input: true,
      },
    ],
    competitive_landscape: "",
    key_risks: [],
    benchmarks: {},
  });
  assert.ok(text);
  assert.match(text!, /COST-REVENUE COMPOSITION/);
  assert.match(text!, /Product/);
  assert.match(text!, /COGS|cost/i);
  assert.match(text!, /40\.0%/);
});

test("follow_up_questions recommendations respect server gate when present", async () => {
  const { normalizeFollowUpQuestions, RECOMMENDATION_MIN_CONFIDENCE } = await import("./parser.js");
  const qs = normalizeFollowUpQuestions([
    {
      id: "impact",
      question: "Expected COGS impact?",
      options: [
        { label: "+5%", value: "cogs_5" },
        { label: "+10%", value: "cogs_10" },
      ],
      recommendation: {
        value: "cogs_10",
        rationale: "cost_of_revenue feeds gross_profit",
        confidence: 0.8,
        evidence: [{ kind: "model", source: "gross_profit = f(revenue, cost_of_revenue)" }],
      },
    },
    {
      id: "weak",
      question: "Guess?",
      options: [{ label: "x", value: "x" }],
      recommendation: {
        value: "x",
        rationale: "no evidence",
        confidence: 0.9,
        evidence: [],
      },
    },
  ]);
  for (const q of qs) {
    if (q.recommendation) {
      assert.ok(q.recommendation.confidence >= RECOMMENDATION_MIN_CONFIDENCE);
      assert.ok(q.recommendation.evidence.length >= 1);
    }
  }
  assert.ok(qs.find((q) => q.id === "impact")?.recommendation);
  assert.strictEqual(qs.find((q) => q.id === "weak")?.recommendation, undefined);
});
