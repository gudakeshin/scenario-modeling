/**
 * Pure unit tests for follow-up recommendation normalization and driver dependency description.
 */

import test from "node:test";
import assert from "node:assert";
import {
  RECOMMENDATION_MIN_CONFIDENCE,
  normalizeFollowUpQuestions,
  describeDriverDependencies,
  type FollowUpQuestion,
} from "./followUpQuestions.js";
import { refineScenarioSchema } from "../schemas/auth.js";
import type { ModelDefinition } from "../models/registry.js";

test("normalizeFollowUpQuestions: strips low-confidence recommendations", () => {
  const raw = [
    {
      id: "impact",
      question: "How large is the COGS hit?",
      options: [
        { label: "COGS +5%", value: "cogs_up_5" },
        { label: "COGS +10%", value: "cogs_up_10" },
      ],
      allow_custom: true,
      recommendation: {
        value: "cogs_up_10",
        rationale: "Docs mention a 10% materials spike.",
        confidence: 0.4,
        evidence: [{ kind: "document", source: "risk memo", snippet: "materials +10%" }],
      },
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.strictEqual(qs.length, 1);
  assert.strictEqual(qs[0].recommendation, undefined);
  assert.strictEqual(qs[0].question_type, "choice");
  assert.ok(qs[0].options.length === 2);
});

test("normalizeFollowUpQuestions: strips evidence-less recommendations", () => {
  const raw = [
    {
      id: "impact",
      question: "Impact?",
      options: [{ label: "A", value: "a" }],
      recommendation: {
        value: "a",
        rationale: "Guessing.",
        confidence: 0.9,
        evidence: [],
      },
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.strictEqual(qs[0].recommendation, undefined);
});

test("normalizeFollowUpQuestions: keeps gated recommendations", () => {
  const raw = [
    {
      id: "impact",
      question: "Impact?",
      options: [
        { label: "Volume -5%", value: "vol_down_5" },
        { label: "COGS +8%", value: "cogs_up_8" },
      ],
      recommendation: {
        value: "cogs_up_8",
        rationale: "gross_profit depends on cost_of_revenue.",
        confidence: RECOMMENDATION_MIN_CONFIDENCE,
        evidence: [
          { kind: "model", source: "gross_profit = f(revenue, cost_of_revenue)" },
        ],
      },
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.ok(qs[0].recommendation);
  assert.strictEqual(qs[0].recommendation!.value, "cogs_up_8");
  assert.strictEqual(qs[0].recommendation!.confidence, 0.6);
  assert.strictEqual(qs[0].recommendation!.evidence.length, 1);
});

test("normalizeFollowUpQuestions: no-options question becomes open", () => {
  const raw = [
    {
      id: "freeform",
      question: "Describe the supply-chain impact.",
      options: [],
      recommendation: {
        value: "something",
        rationale: "Should be stripped because open.",
        confidence: 0.9,
        evidence: [{ kind: "context", source: "company context" }],
      },
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.strictEqual(qs[0].question_type, "open");
  assert.strictEqual(qs[0].recommendation, undefined);
});

test("normalizeFollowUpQuestions: appends out-of-options value when allow_custom is false", () => {
  const raw = [
    {
      id: "impact",
      question: "Magnitude?",
      options: [{ label: "Mild", value: "mild" }],
      allow_custom: false,
      recommendation: {
        value: "severe_cogs_12",
        label: "COGS +12% (severe)",
        rationale: "Model chain implies materials shock.",
        confidence: 0.85,
        evidence: [{ kind: "model", source: "cost_of_revenue = f(raw_materials)" }],
      },
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.ok(qs[0].recommendation);
  assert.ok(qs[0].options.some((o) => o.value === "severe_cogs_12"));
  assert.strictEqual(
    qs[0].options.find((o) => o.value === "severe_cogs_12")?.label,
    "COGS +12% (severe)",
  );
});

test("normalizeFollowUpQuestions: legacy questions pass through unchanged", () => {
  const raw = [
    {
      id: "geo",
      question: "Which region?",
      options: [
        { label: "APAC", value: "apac" },
        { label: "EMEA", value: "emea" },
      ],
      allow_custom: true,
    },
  ];
  const qs = normalizeFollowUpQuestions(raw);
  assert.strictEqual(qs.length, 1);
  assert.strictEqual(qs[0].id, "geo");
  assert.strictEqual(qs[0].question_type, "choice");
  assert.strictEqual(qs[0].recommendation, undefined);
  assert.strictEqual(qs[0].allow_custom, true);
  assert.deepStrictEqual(qs[0].options, raw[0].options);
});

test("normalizeFollowUpQuestions: fills missing ids", () => {
  const qs = normalizeFollowUpQuestions([
    {
      question: "No id here",
      options: [{ label: "Yes", value: "yes" }],
    },
  ]);
  assert.strictEqual(qs.length, 1);
  assert.ok(qs[0].id.startsWith("q_"));
});

test("describeDriverDependencies: emits f(...) lines and input levers", () => {
  const model: ModelDefinition = {
    model_version: "test-v1",
    time_horizon: { start: "2024-01", end: "2024-12", granularity: "monthly" },
    variables: [
      { id: "revenue", name: "Revenue", formula: "100", dependencies: [], tags: ["input"] },
      { id: "cost_of_revenue", name: "COGS", formula: "40", dependencies: [], tags: ["input"] },
      {
        id: "gross_profit",
        name: "Gross Profit",
        formula: "revenue - cost_of_revenue",
        dependencies: ["revenue", "cost_of_revenue"],
        tags: ["output"],
      },
    ],
  };
  const desc = describeDriverDependencies(model);
  assert.ok(desc.includes("gross_profit = f(revenue, cost_of_revenue)"));
  assert.ok(desc.includes("INPUT LEVERS:"));
  assert.ok(desc.includes("- revenue (Revenue)"));
  assert.ok(desc.includes("- cost_of_revenue (COGS)"));
});

test("refineScenarioSchema: accepts legacy and enriched answer payloads", () => {
  const legacy = refineScenarioSchema.parse({
    answers: [{ question_id: "impact", answer: "cogs_up_8" }],
  });
  assert.strictEqual(legacy.answers![0].answer, "cogs_up_8");
  assert.strictEqual(legacy.answers![0].answer_kind, undefined);

  const enriched = refineScenarioSchema.parse({
    answers: [
      {
        question_id: "impact",
        answer: "cogs_up_5",
        answer_kind: "overridden",
        recommended_value: "cogs_up_8",
      },
      {
        question_id: "notes",
        answer: "Expect a two-quarter lag",
        answer_kind: "comment",
      },
      {
        question_id: "confirm",
        answer: "vol_down_5",
        answer_kind: "accepted_recommendation",
      },
    ],
  });
  assert.strictEqual(enriched.answers!.length, 3);
  assert.strictEqual(enriched.answers![0].answer_kind, "overridden");
  assert.strictEqual(enriched.answers![0].recommended_value, "cogs_up_8");
});

test("surviving recommendations always pass the server gate", () => {
  const noisy: unknown[] = [
    {
      id: "a",
      question: "A?",
      options: [{ label: "x", value: "x" }],
      recommendation: {
        value: "x",
        rationale: "ok",
        confidence: 0.59,
        evidence: [{ kind: "model", source: "rev" }],
      },
    },
    {
      id: "b",
      question: "B?",
      options: [{ label: "y", value: "y" }],
      recommendation: {
        value: "y",
        rationale: "ok",
        confidence: 0.75,
        evidence: [{ kind: "document", source: "memo", snippet: "y" }],
      },
    },
    {
      id: "c",
      question: "C?",
      options: [{ label: "z", value: "z" }],
      recommendation: {
        value: "z",
        rationale: "no evidence",
        confidence: 0.99,
        evidence: [],
      },
    },
  ];
  const qs: FollowUpQuestion[] = normalizeFollowUpQuestions(noisy);
  for (const q of qs) {
    if (q.recommendation) {
      assert.ok(q.recommendation.confidence >= RECOMMENDATION_MIN_CONFIDENCE);
      assert.ok(q.recommendation.evidence.length >= 1);
    }
  }
  assert.strictEqual(qs.find((q) => q.id === "a")?.recommendation, undefined);
  assert.ok(qs.find((q) => q.id === "b")?.recommendation);
  assert.strictEqual(qs.find((q) => q.id === "c")?.recommendation, undefined);
});
