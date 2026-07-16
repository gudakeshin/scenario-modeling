import test from "node:test";
import assert from "node:assert";
import {
  detectAnalysisMode,
  analysisMentionsIntegrity,
  extractNumericClaims,
  verifyEvidenceAgainstValues,
  attachRemediationMeta,
  type BusinessInsight,
} from "./businessAnalysisAgent.js";
import { integrityDiagnosisCheck } from "./qaAgent.js";

const sampleInsight = (over: Partial<BusinessInsight> = {}): BusinessInsight => ({
  headline: "Model baseline missing — halt delta-based decisions until base P&L is reloaded",
  implications: [
    {
      title: "Zero-baseline architecture invalidates percentage changes",
      detail: "Every base P&L line is ~0 so n/a% deltas are uninterpretable.",
      severity: "negative",
    },
  ],
  risks: [
    {
      risk: "Model integrity failure from zero baseline",
      likelihood: "high",
      mitigation: "Reload base case and re-run",
    },
  ],
  recommendations: [
    {
      action: "Reload valid base-case P&L and re-run scenario",
      priority: "immediate",
      rationale: "Restore model credibility before circulating results.",
      owner: "FP&A",
    },
  ],
  decision_context: "Do not treat percentage-change metrics as business impact until baseline is fixed.",
  confidence_note: "AI-generated analysis — validate with domain experts.",
  ...over,
});

test("detectAnalysisMode: zero base with material scenario → integrity", () => {
  const mode = detectAnalysisMode({
    pl: { revenue: 10986.18, other_overheads: 18, ebitda_margin: 0.39 },
    base_pl: { revenue: 0, other_overheads: 0, ebitda_margin: 0 },
  });
  assert.strictEqual(mode.mode, "integrity");
  assert.ok(mode.reasons.length > 0);
});

test("detectAnalysisMode: missing base with material scenario → integrity", () => {
  const mode = detectAnalysisMode({
    pl: { revenue: 5000, net_income: 400 },
    base_pl: {},
  });
  assert.strictEqual(mode.mode, "integrity");
});

test("detectAnalysisMode: normal base → standard", () => {
  const mode = detectAnalysisMode({
    pl: { revenue: 1100, net_income: 220 },
    base_pl: { revenue: 1000, net_income: 200 },
  });
  assert.strictEqual(mode.mode, "standard");
  assert.deepStrictEqual(mode.reasons, []);
});

test("detectAnalysisMode: absurdity warnings with zero base → integrity", () => {
  const mode = detectAnalysisMode({
    pl: { material_cost: 50, gross_profit: -10 },
    base_pl: { material_cost: 0, gross_profit: 0 },
    absurdity_warnings: ["material_cost changed by 1537%"],
  });
  assert.strictEqual(mode.mode, "integrity");
});

test("extractNumericClaims: parses comma and decimal forms", () => {
  const nums = extractNumericClaims("Gross revenue ₹10,986.18 Cr; overheads ₹182.7");
  assert.ok(nums.includes(10986.18));
  assert.ok(nums.includes(182.7));
});

test("extractNumericClaims: masks years and percent ranges", () => {
  const nums = extractNumericClaims(
    "Target alternate capacity by Q2 2025; timelines Q2/Q3/Q4 2026; levers 25–50% effective, 6.5% cost, -10% volume",
  );
  assert.ok(!nums.includes(25), `should not extract 25 from 2025/25%: ${nums}`);
  assert.ok(!nums.includes(26), `should not extract 26 from 2026: ${nums}`);
  assert.ok(!nums.includes(2025));
  assert.ok(!nums.includes(6.5));
  assert.ok(!nums.includes(-10));
});

test("verifyEvidenceAgainstValues: evidence mismatch fails", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "EBITDA margin cited",
        detail: "EBITDA margin is -5.35 under the scenario",
        severity: "negative",
        evidence: [{ metric_id: "ebitda_margin", value: -5.35 }],
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(insight, { ebitda_margin: 0.39, other_overheads: 18 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.mismatches.some((m) => m.metric_id === "ebitda_margin" && m.actual_value === 0.39));
});

test("verifyEvidenceAgainstValues: free-text 182.7 vs actual 18 fails (scale)", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Overhead increase to ₹182.7 Cr/mo",
        detail: "Other overheads rise to ₹182.7 Cr/month under escalation.",
        severity: "negative",
        evidence: [{ metric_id: "other_overheads", value: 182.7 }],
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(insight, { other_overheads: 18, revenue: 10986.18 });
  assert.strictEqual(result.ok, false);
  assert.ok(
    result.mismatches.some(
      (m) => m.metric_id === "other_overheads" && m.claimed_value === 182.7 && m.actual_value === 18,
    ),
  );
});

test("verifyEvidenceAgainstValues: numeric implication without evidence fails", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Revenue at 10986.18",
        detail: "Scenario produces 10986.18 gross revenue",
        severity: "neutral",
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(insight, { revenue: 10986.18 });
  assert.strictEqual(result.ok, false);
  assert.ok(result.mismatches.some((m) => m.metric_id === "evidence_required"));
});

test("verifyEvidenceAgainstValues: canonical values with evidence pass", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Scenario absolute levels are not proven net impact",
        detail: "Scenario shows revenue=10986.18 — cite only as levels, not as impact vs base.",
        severity: "negative",
        evidence: [{ metric_id: "revenue", value: 10986.18 }],
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(insight, { revenue: 10986.18, other_overheads: 18 });
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("verifyEvidenceAgainstValues: base=0 evidence valid when scenario is material", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Zero baseline invalidates all percentage deltas",
        detail: "Base gross_revenue_cr is 0 so n/a% swings are math artifacts.",
        severity: "negative",
        evidence: [{ metric_id: "gross_revenue_cr", value: 0 }],
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(
    insight,
    { gross_revenue_cr: 10986.18, io_004: 0.24, neem_trainee: 5 },
    { gross_revenue_cr: 0, io_004: 0, neem_trainee: 0 },
  );
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("verifyEvidenceAgainstValues: empty base_pl still accepts base=0 evidence", () => {
  // resolveBasePl often returns {} for XLSX / missing base — same as base_pl[k] ?? 0
  const insight = sampleInsight({
    implications: [
      {
        title: "Zero baseline invalidates all percentage deltas",
        detail: "Baseline P&L is 0 across all metrics.",
        severity: "negative",
        evidence: [
          { metric_id: "gross_revenue_cr", value: 0 },
          { metric_id: "total_gross_revenue_cr", value: 0 },
        ],
      },
      {
        title: "Scenario absolute levels exist but cannot prove net war impact",
        detail: "Scenario shows gross_revenue_cr=10986.18 and total_gross_revenue_cr=12435.82.",
        severity: "negative",
        evidence: [
          { metric_id: "gross_revenue_cr", value: 10986.18 },
          { metric_id: "total_gross_revenue_cr", value: 12435.82 },
        ],
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(
    insight,
    { gross_revenue_cr: 10986.18, total_gross_revenue_cr: 12435.82, marketing_brand_costs: 2 },
    {},
  );
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("verifyEvidenceAgainstValues: ₹200 Cr contingency does not attach to marketing_brand_costs", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Assumption levers are plausible for preparedness planning",
        detail: "6.5% material cost escalation, 10% volume drop, 2.5% marketing cut.",
        severity: "neutral",
      },
    ],
    recommendations: [
      {
        action: "Establish ₹200 Cr contingency reserve for expedited logistics",
        priority: "short-term",
        rationale: "Buffer if war escalates beyond Q3 2026",
        owner: "CFO",
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(
    insight,
    { marketing_brand_costs: 2, gross_revenue_cr: 10986.18 },
    {},
  );
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("verifyEvidenceAgainstValues: integrity narrative with years/contingency passes", () => {
  // Mirrors the US-Iran QA failure: years→25/26, ₹50→neem_trainee scale, free_text 0
  const insight = sampleInsight({
    headline: "Model baseline is zero—all % deltas are invalid; do not decide until base P&L is reloaded",
    implications: [
      {
        title: "Zero baseline invalidates all percentage deltas",
        detail: "Base P&L is 0 across key lines; n/a% swings are artifacts.",
        severity: "negative",
        evidence: [{ metric_id: "gross_revenue_cr", value: 0 }],
      },
      {
        title: "Scenario shows material-cost lever at 6.39",
        detail: "Material cost per NSP is 6.39 — preparedness lever, not proven delta.",
        severity: "neutral",
        evidence: [{ metric_id: "material_cost_nsp", value: 6.39 }],
      },
    ],
    risks: [
      {
        risk: "Geopolitical escalation timeline uncertain beyond Q3 2026",
        likelihood: "medium",
        mitigation: "Model Q2/Q3/Q4 2026 paths; supplier diversification 25–50% may not offset volume loss",
      },
    ],
    recommendations: [
      {
        action: "Establish dual-source contracts; target 40% alternate capacity by Q2 2025",
        priority: "immediate",
        rationale: "High supply-chain exposure requires pre-positioned alternatives",
        owner: "Operations",
      },
      {
        action: "Reserve ₹50 Cr contingency fund for expedited logistics",
        priority: "short-term",
        rationale: "Liquidity buffer for supply-chain shocks",
        owner: "CFO",
      },
    ],
  });
  const result = verifyEvidenceAgainstValues(
    insight,
    {
      gross_revenue_cr: 10986.18,
      total_gross_revenue_cr: 12435.82,
      material_cost_nsp: 6.39,
      io_004: 0.24,
      neem_trainee: 5,
    },
    {
      gross_revenue_cr: 0,
      total_gross_revenue_cr: 0,
      material_cost_nsp: 0,
      io_004: 0,
      neem_trainee: 0,
    },
  );
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("verifyEvidenceAgainstValues: qualitative zero prose without phantom free_text", () => {
  const insight = sampleInsight({
    implications: [
      {
        title: "Zero baseline invalidates deltas",
        detail: "Every base line is ~0 so percentages are uninterpretable.",
        severity: "negative",
      },
    ],
  });
  // Ambient "0" is not extracted as a model claim; no evidence_required / free_text phantom
  const result = verifyEvidenceAgainstValues(insight, { revenue: 10986.18 }, { revenue: 0 });
  assert.strictEqual(result.ok, true, JSON.stringify(result.mismatches));
});

test("analysisMentionsIntegrity / integrityDiagnosisCheck", () => {
  const good = sampleInsight();
  assert.strictEqual(analysisMentionsIntegrity(good), true);
  assert.strictEqual(
    integrityDiagnosisCheck(good, { mode: "integrity", reasons: ["zero base"] }).ok,
    true,
  );

  const bad = sampleInsight({
    headline: "War scenario shows healthy profitability and intact revenue",
    implications: [
      {
        title: "Revenue generation appears intact",
        detail: "Scenario produces strong gross revenue despite volume reduction.",
        severity: "positive",
      },
    ],
    risks: [
      {
        risk: "Geopolitical escalation could disrupt supply",
        likelihood: "medium",
        mitigation: "Develop contingency plans with alternate suppliers",
      },
    ],
    recommendations: [
      {
        action: "Invest in supplier diversification",
        priority: "short-term",
        rationale: "Reduce concentration risk in conflict-exposed routes",
        owner: "Procurement",
      },
    ],
    decision_context: "Proceed with mitigation investments.",
    confidence_note: "AI-generated analysis — validate with domain experts.",
  });
  assert.strictEqual(analysisMentionsIntegrity(bad), false);
  const check = integrityDiagnosisCheck(bad, { mode: "integrity", reasons: ["zero base"] });
  assert.strictEqual(check.ok, false);
  assert.ok(/integrity|baseline/i.test(check.guidance));
});

test("integrityDiagnosisCheck: standard mode always ok", () => {
  const insight = sampleInsight({
    headline: "Revenue up on volume growth",
    implications: [{ title: "Growth", detail: "Top line expands", severity: "positive" }],
  });
  assert.strictEqual(
    integrityDiagnosisCheck(insight, { mode: "standard", reasons: [] }).ok,
    true,
  );
});

test("attachRemediationMeta: integrity mode injects model + review CTAs", () => {
  const insight = sampleInsight({
    recommendations: [
      {
        action: "Do qualitative preparedness planning",
        priority: "short-term",
        rationale: "Levers remain useful",
        owner: "Strategy",
      },
    ],
  });
  const out = attachRemediationMeta(insight, {
    mode: "integrity",
    reasons: ["All base P&L values are ~0"],
  });
  assert.strictEqual(out.analysis_mode, "integrity");
  assert.ok(out.recommendations.some((r) => r.cta === "open_doc_manager_model"));
  assert.ok(out.recommendations.some((r) => r.cta === "open_review"));
});
