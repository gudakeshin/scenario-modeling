/**
 * LLM accounting-fidelity agent — propose fixes, accept only when deterministic
 * tie-out passes (mirrors tryIdentityRepair in contextEngine).
 */

import { z } from "zod";
import { config } from "../config.js";
import { callClaudeStructured, getApiKey } from "./llmClient.js";
import { logger } from "../logger.js";
import {
  attemptDeterministicNormalization,
  checkInvariants,
  type InvariantViolation,
} from "./financialInvariants.js";

const MAX_ROUNDS = 3;

const proposedFixSchema = z.object({
  kind: z.enum([
    "recompute_metric",
    "sign_flip",
    "formula_correction",
    "metric_type_correction",
    "aggregation_kind_change",
    "dependency_order",
  ]),
  metric: z.string(),
  /** Absolute value to write into P&L when kind=recompute_metric / sign_flip. */
  proposed_value: z.number().nullable().optional(),
  /** Optional formula string for documentation / model mutation callers. */
  proposed_formula: z.string().nullable().optional(),
  rationale: z.string(),
});

const reviewSchema = z.object({
  findings: z.array(
    z.object({
      code: z.string(),
      metric: z.string(),
      severity: z.enum(["error", "warning"]),
      message: z.string(),
    }),
  ),
  proposed_fixes: z.array(proposedFixSchema),
  summary: z.string(),
});

export type ProposedFix = z.infer<typeof proposedFixSchema>;

export interface FidelityReviewInput {
  pl: Record<string, number>;
  basePl?: Record<string, number>;
  residualViolations: InvariantViolation[];
  modelSummary?: string;
  /** Optional model definition snippet for deep review. */
  modelDefinition?: unknown;
}

export interface FidelityReviewResult {
  findings: InvariantViolation[];
  proposedFixes: ProposedFix[];
  appliedFixes: ProposedFix[];
  appliedPl?: Record<string, number>;
  residualViolations: InvariantViolation[];
  notices: string[];
  summary: string;
}

function applyFixToPl(
  pl: Record<string, number>,
  fix: ProposedFix,
): Record<string, number> | null {
  if (fix.proposed_value == null || !Number.isFinite(fix.proposed_value)) return null;
  if (!fix.metric) return null;
  return { ...pl, [fix.metric]: Math.round(fix.proposed_value * 100) / 100 };
}

/**
 * Review residual invariant violations. LLM proposes; deterministic gate accepts.
 */
export async function reviewModelFidelity(
  input: FidelityReviewInput,
  opts?: { applyGatedFixes?: boolean },
): Promise<FidelityReviewResult> {
  const notices: string[] = [];
  const applyGated = opts?.applyGatedFixes !== false;

  if (!getApiKey()) {
    return {
      findings: input.residualViolations,
      proposedFixes: [],
      appliedFixes: [],
      residualViolations: input.residualViolations,
      notices: ["Fidelity agent unavailable — ANTHROPIC_API_KEY not set"],
      summary: "Skipped LLM review (no API key)",
    };
  }

  if (input.residualViolations.length === 0) {
    return {
      findings: [],
      proposedFixes: [],
      appliedFixes: [],
      residualViolations: [],
      notices: [],
      summary: "No residual violations",
    };
  }

  let review: z.infer<typeof reviewSchema>;
  try {
    review = await callClaudeStructured({
      purpose: "agent",
      toolName: "accounting_fidelity_review",
      toolDescription: "Propose accounting fixes for P&L invariant violations",
      schema: reviewSchema,
      maxTokens: 2500,
      system: `You are an FP&A accounting fidelity reviewer.
Given a reported P&L and invariant violations, propose concrete numeric corrections.
Rules:
- Prefer identity repairs: EBITDA = gross_profit - operating_expenses, margins = num/den*100.
- Never invent metrics not in the P&L.
- proposed_value must be a finite number when kind is recompute_metric or sign_flip.
- Costs reduce profit; never add absolute OpEx to gross profit to get EBITDA.
- Keep responses minimal and auditable.`,
      userMessage: JSON.stringify({
        pl: input.pl,
        base_pl: input.basePl,
        violations: input.residualViolations,
        model_summary: input.modelSummary,
        model_definition: input.modelDefinition
          ? JSON.stringify(input.modelDefinition).slice(0, 8000)
          : undefined,
      }),
    });
  } catch (e) {
    logger.warn(`[FidelityAgent] LLM review failed: ${(e as Error).message}`);
    return {
      findings: input.residualViolations,
      proposedFixes: [],
      appliedFixes: [],
      residualViolations: input.residualViolations,
      notices: [`Fidelity agent LLM failed: ${(e as Error).message}`],
      summary: "LLM review failed",
    };
  }

  const proposedFixes = review.proposed_fixes ?? [];
  const findings: InvariantViolation[] = (review.findings ?? []).map((f) => ({
    code: f.code,
    severity: f.severity,
    metric: f.metric,
    message: f.message,
  }));

  if (!applyGated) {
    return {
      findings: findings.length ? findings : input.residualViolations,
      proposedFixes,
      appliedFixes: [],
      residualViolations: input.residualViolations,
      notices,
      summary: review.summary,
    };
  }

  // Tie-out gate: apply fixes one-by-one on a clone; keep only those that reduce violations
  let working = { ...input.pl };
  const appliedFixes: ProposedFix[] = [];
  let residual = checkInvariants(working);

  for (let round = 0; round < MAX_ROUNDS && residual.length > 0; round++) {
    let progressed = false;
    for (const fix of proposedFixes) {
      if (appliedFixes.includes(fix)) continue;
      const trial = applyFixToPl(working, fix);
      if (!trial) continue;
      // Also run deterministic normalization on the trial
      const norm = attemptDeterministicNormalization(trial);
      const trialViolations = norm.residualViolations;
      if (trialViolations.length < residual.length) {
        working = norm.pl;
        residual = trialViolations;
        appliedFixes.push(fix);
        notices.push(`Accepted gated fix: ${fix.kind} on ${fix.metric} — ${fix.rationale}`);
        progressed = true;
      } else {
        notices.push(`Rejected fix (no tie-out improvement): ${fix.kind} on ${fix.metric}`);
      }
    }
    if (!progressed) break;
  }

  return {
    findings: findings.length ? findings : input.residualViolations,
    proposedFixes,
    appliedFixes,
    appliedPl: appliedFixes.length > 0 ? working : undefined,
    residualViolations: residual,
    notices,
    summary: review.summary,
  };
}

/** Deep model-build review — returns gated numeric PL patches + model mutation hints. */
export async function reviewModelBuildFidelity(opts: {
  pl: Record<string, number>;
  modelDefinition: unknown;
  modelSummary?: string;
}): Promise<FidelityReviewResult> {
  const { residualViolations, pl, applied } = attemptDeterministicNormalization(opts.pl);
  const base = {
    findings: residualViolations,
    proposedFixes: [] as ProposedFix[],
    appliedFixes: [] as ProposedFix[],
    appliedPl: applied.length > 0 ? pl : undefined,
    residualViolations,
    notices: applied.map((a) => `Deterministic repair: ${a}`),
    summary: applied.length ? "Deterministic repairs applied" : "Clean after deterministic pass",
  };

  if (residualViolations.length === 0 || !config.FIDELITY_AGENT_ENABLED) {
    return base;
  }

  const agent = await reviewModelFidelity(
    {
      pl,
      residualViolations,
      modelSummary: opts.modelSummary,
      modelDefinition: opts.modelDefinition,
    },
    { applyGatedFixes: true },
  );

  return {
    ...agent,
    notices: [...base.notices, ...agent.notices],
    appliedPl: agent.appliedPl ?? base.appliedPl,
  };
}
