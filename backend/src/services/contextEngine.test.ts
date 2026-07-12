import test from "node:test";
import assert from "node:assert";
import { buildModelFromContext, rewriteTaxAsEffectiveRate, selectKnownFormula, type ContextData, type FinancialMetric } from "./contextEngine.js";
import { CompiledModel } from "./expression.js";

function metric(partial: Partial<FinancialMetric> & Pick<FinancialMetric, "name" | "variable_id" | "category" | "is_input">): FinancialMetric {
  return {
    description: partial.name,
    unit: "USD",
    dependencies: [],
    ...partial,
  };
}

function miniCtx(metrics: FinancialMetric[]): ContextData {
  return {
    company_name: "TestCo",
    industry: "Tech",
    business_model: "SaaS",
    revenue_streams: [],
    financial_metrics: metrics,
    competitive_landscape: "",
    key_risks: [],
    benchmarks: {},
  };
}

test("buildModelFromContext: missing depreciation assumed 0 — no magic 1200", () => {
  const ctx = miniCtx([
    metric({ name: "Revenue", variable_id: "revenue", category: "revenue", is_input: true, typical_value: 10000, formula: "10000" }),
    metric({
      name: "EBIT",
      variable_id: "ebit",
      category: "income",
      is_input: false,
      formula: "revenue - depreciation",
      dependencies: ["revenue", "depreciation"],
      typical_value: 8800,
    }),
  ]);
  const model = buildModelFromContext(ctx);
  const dep = model.variables.find((v) => v.id === "depreciation");
  assert.ok(dep);
  assert.strictEqual(dep!.formula, "0");
  assert.strictEqual(dep!.provenance, "assumed");
  assert.ok(model.build_warnings?.some((w) => /depreciation/i.test(w) && /assumed 0/i.test(w)));
  const blob = JSON.stringify(model);
  assert.ok(!blob.includes("1200"));
  assert.ok(!blob.includes("1885"));
});

test("selectKnownFormula: ebitda − ebit == D&A with GP/opex/DA present", () => {
  const vars = new Set(["gross_profit", "operating_expenses", "depreciation_amortization", "ebitda", "ebit"]);
  const ebitda = selectKnownFormula("ebitda", vars)!;
  const ebit = selectKnownFormula("ebit", vars)!;
  assert.strictEqual(ebitda.formula, "gross_profit - operating_expenses");
  assert.strictEqual(ebit.formula, "ebitda - depreciation_amortization");

  const model = new CompiledModel({
    model_version: "id",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables: [
      { id: "gross_profit", name: "GP", formula: "5000", dependencies: [] },
      { id: "operating_expenses", name: "Opex", formula: "2000", dependencies: [] },
      { id: "depreciation_amortization", name: "D&A", formula: "500", dependencies: [] },
      { id: "ebitda", name: "EBITDA", formula: ebitda.formula, dependencies: ebitda.deps },
      { id: "ebit", name: "EBIT", formula: ebit.formula, dependencies: ebit.deps },
    ],
  });
  const b = model.baseValues();
  assert.strictEqual(b.ebitda, 3000);
  assert.strictEqual(b.ebit, 2500);
  assert.strictEqual(b.ebitda - b.ebit, 500);
});

test("rewriteTaxAsEffectiveRate: PBT 2000 / tax 500 → 25%; scales with revenue", () => {
  const variables = [
    { id: "revenue", name: "Revenue", formula: "10000", dependencies: [] as string[], tags: ["pl_metric", "input", "percent_delta"], metric_type: "currency" as const },
    { id: "costs", name: "Costs", formula: "8000", dependencies: [] as string[], tags: ["pl_metric", "input"], metric_type: "currency" as const },
    { id: "profit_before_tax", name: "PBT", formula: "revenue - costs", dependencies: ["revenue", "costs"], tags: ["pl_metric", "output"], metric_type: "currency" as const },
    { id: "tax_expense", name: "Tax", formula: "500", dependencies: [] as string[], tags: ["pl_metric", "input", "percent_delta"], metric_type: "currency" as const },
    { id: "net_income", name: "NI", formula: "profit_before_tax - tax_expense", dependencies: ["profit_before_tax", "tax_expense"], tags: ["pl_metric", "output"], metric_type: "currency" as const },
  ];
  const warnings: string[] = [];
  rewriteTaxAsEffectiveRate(variables, warnings);
  const rate = variables.find((v) => v.id === "effective_tax_rate");
  assert.ok(rate);
  assert.strictEqual(Number(rate!.formula), 25);
  assert.ok(warnings.some((w) => /effective rate 25/i.test(w)));

  const model = new CompiledModel({
    model_version: "tax",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables,
  });
  const doubled = model.evaluate({ revenue: 20000 });
  // PBT = 12000, tax = 25% of 12000 = 3000
  assert.ok(Math.abs(doubled.tax_expense - 3000) < 0.01, `tax=${doubled.tax_expense}`);
  assert.ok(Math.abs(doubled.net_income - 9000) < 0.01);
});

test("rewriteTaxAsEffectiveRate: PBT ≤ 0 skips with warning", () => {
  const variables = [
    { id: "profit_before_tax", name: "PBT", formula: "-100", dependencies: [] as string[], tags: ["output"], metric_type: "currency" as const },
    { id: "tax_expense", name: "Tax", formula: "50", dependencies: [] as string[], tags: ["input"], metric_type: "currency" as const },
  ];
  const warnings: string[] = [];
  rewriteTaxAsEffectiveRate(variables, warnings);
  assert.ok(!variables.some((v) => v.id === "effective_tax_rate"));
  assert.ok(warnings.some((w) => /skipped/i.test(w)));
});

test("rewriteTaxAsEffectiveRate: loss → tax 0 via max(0, PBT)", () => {
  const variables = [
    { id: "revenue", name: "R", formula: "1000", dependencies: [] as string[], tags: ["input"], metric_type: "currency" as const },
    { id: "costs", name: "C", formula: "500", dependencies: [] as string[], tags: ["input"], metric_type: "currency" as const },
    { id: "profit_before_tax", name: "PBT", formula: "revenue - costs", dependencies: ["revenue", "costs"], tags: ["output"], metric_type: "currency" as const },
    { id: "tax_expense", name: "Tax", formula: "125", dependencies: [] as string[], tags: ["input"], metric_type: "currency" as const },
  ];
  rewriteTaxAsEffectiveRate(variables, []);
  const model = new CompiledModel({
    model_version: "loss",
    time_horizon: { start: "2026-Q1", end: "2026-Q1", granularity: "quarterly" },
    variables,
  });
  const loss = model.evaluate({ revenue: 100, costs: 500 });
  assert.strictEqual(loss.tax_expense, 0);
});
