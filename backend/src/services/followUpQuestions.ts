/**
 * Shared follow-up question types, zod schemas, and recommendation gate.
 * Kept separate from parser.ts to avoid circular imports with scenarioReasoningAgent.
 */

import { z } from "zod";
import { logger } from "../logger.js";

/** Server-enforced floor: recommendations below this are stripped. */
export const RECOMMENDATION_MIN_CONFIDENCE = 0.6;

export const recommendationEvidenceSchema = z.object({
  kind: z.enum(["model", "document", "context", "web"]),
  source: z.string(),
  snippet: z.string().optional(),
});

export const followUpRecommendationSchema = z.object({
  value: z.string(),
  label: z.string().optional(),
  rationale: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0),
  evidence: z.array(recommendationEvidenceSchema).default([]),
});

export const followUpQuestionSchema = z.object({
  id: z.string().default(""),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  allow_custom: z.boolean().default(true),
  question_type: z.enum(["choice", "open"]).optional(),
  recommendation: followUpRecommendationSchema.optional().nullable(),
});

export interface RecommendationEvidence {
  kind: "model" | "document" | "context" | "web";
  source: string;
  snippet?: string;
}

export interface FollowUpRecommendation {
  value: string;
  label?: string;
  rationale: string;
  confidence: number;
  evidence: RecommendationEvidence[];
}

export interface FollowUpQuestion {
  id: string;
  question: string;
  options: { label: string; value: string }[];
  allow_custom?: boolean;
  question_type?: "choice" | "open";
  recommendation?: FollowUpRecommendation;
}

/**
 * Normalize LLM/legacy follow-up questions: fill ids, enforce recommendation
 * gate (confidence + evidence), promote open questions, and ensure recommended
 * values are selectable when allow_custom is false.
 */
export function normalizeFollowUpQuestions(raw: unknown): FollowUpQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const out: FollowUpQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;

    // Parse base fields; tolerate a bad recommendation by stripping it first
    const rawRec = (item as { recommendation?: unknown }).recommendation;
    const withoutRec = { ...(item as Record<string, unknown>) };
    delete withoutRec.recommendation;
    const parsed = followUpQuestionSchema.safeParse(withoutRec);
    if (!parsed.success) continue;

    const q = parsed.data;
    const id = q.id?.trim() || `q_${Math.random().toString(36).slice(2, 8)}`;
    let options = Array.isArray(q.options) ? [...q.options] : [];
    let questionType = q.question_type;
    let recommendation: FollowUpRecommendation | undefined;

    if (rawRec != null && questionType !== "open") {
      const recParsed = followUpRecommendationSchema.safeParse(rawRec);
      if (recParsed.success) {
        const rec = recParsed.data;
        const evidence = Array.isArray(rec.evidence)
          ? rec.evidence.filter((e) => e.source?.trim())
          : [];
        if (rec.value && rec.confidence >= RECOMMENDATION_MIN_CONFIDENCE && evidence.length >= 1) {
          recommendation = {
            value: rec.value,
            label: rec.label,
            rationale: rec.rationale,
            confidence: rec.confidence,
            evidence,
          };
          if (
            recommendation.value &&
            !options.some((o) => o.value === recommendation!.value) &&
            q.allow_custom === false
          ) {
            options.push({
              label: recommendation.label || recommendation.value,
              value: recommendation.value,
            });
          }
        } else {
          logger.info(
            {
              question_id: id,
              confidence: rec.confidence,
              evidence_count: evidence.length,
            },
            "[Parser] Stripped follow-up recommendation (below gate)",
          );
        }
      } else {
        logger.info({ question_id: id }, "[Parser] Stripped malformed follow-up recommendation");
      }
    }

    if (options.length === 0) {
      questionType = "open";
      recommendation = undefined;
    } else if (!questionType) {
      questionType = "choice";
    }

    out.push({
      id,
      question: q.question,
      options,
      allow_custom: q.allow_custom !== false,
      question_type: questionType,
      ...(recommendation ? { recommendation } : {}),
    });
  }
  return out;
}

/** Cheap driver-dependency summary for probing prompts (no full driver tree). */
export function describeDriverDependencies(
  model: { variables: Array<{ id: string; name?: string; dependencies: string[]; tags?: string[] }> },
  maxVars = 30,
): string {
  const lines: string[] = ["MODEL DRIVERS:"];
  const calculated = model.variables.filter((v) => v.dependencies.length > 0).slice(0, maxVars);
  for (const v of calculated) {
    lines.push(`  ${v.id} = f(${v.dependencies.join(", ")})`);
  }
  const inputs = model.variables
    .filter((v) => v.dependencies.length === 0 && (!v.tags || v.tags.includes("input") || !v.tags.includes("output")))
    .slice(0, maxVars);
  if (inputs.length > 0) {
    lines.push("INPUT LEVERS:");
    for (const v of inputs) {
      lines.push(`  - ${v.id}${v.name ? ` (${v.name})` : ""}`);
    }
  }
  return lines.join("\n");
}
