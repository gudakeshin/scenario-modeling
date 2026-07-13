/**
 * LLM driver-tree restructuring with reconciliation gate.
 * Numbers stay honest — non-reconciling proposals fall back to the deterministic tree.
 */

import { z } from "zod";
import { config } from "../config.js";
import { callClaudeStructured, getApiKey } from "./llmClient.js";
import { logger } from "../logger.js";
import type { DriverTreeNode, DriverTreeResult } from "./driverTreeService.js";
import type { AttributionBar, AttributionResult } from "./attributionService.js";

const TOL = () => config.FIDELITY_ABS_TOLERANCE ?? 0.5;
const REL = () => config.FIDELITY_REL_TOLERANCE ?? 0.01;

const reasonedNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    value: z.number(),
    editable: z.boolean().optional(),
    rationale: z.string().optional(),
    children: z.array(reasonedNodeSchema).optional(),
  }),
);

const reasonTreeSchema = z.object({
  root: reasonedNodeSchema,
  grouping: z
    .array(
      z.object({
        category: z.string(),
        member_ids: z.array(z.string()),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
});

const attributionReasonSchema = z.object({
  bar_rationales: z.array(
    z.object({
      variable_id: z.string(),
      rationale: z.string(),
      group: z.string().optional(),
    }),
  ),
  driver_groups: z
    .array(
      z.object({
        category: z.string(),
        variable_ids: z.array(z.string()),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
  summary: z.string().optional(),
});

export interface DriverReconciliation {
  ok: boolean;
  failures: Array<{ node_id: string; expected: number; actual: number; message: string }>;
}

function reconciles(parent: number, children: number[]): boolean {
  if (children.length === 0) return true;
  const sum = children.reduce((a, b) => a + b, 0);
  const absTol = TOL();
  const relTol = REL() * Math.max(Math.abs(parent), Math.abs(sum), 1);
  return Math.abs(parent - sum) <= Math.max(absTol, relTol);
}

function collectLeafIds(node: DriverTreeNode, out = new Set<string>()): Set<string> {
  if (!node.children?.length) {
    out.add(node.id);
    return out;
  }
  for (const c of node.children) collectLeafIds(c, out);
  return out;
}

function validateTree(
  node: DriverTreeNode,
  allowedLeaves: Set<string>,
  failures: DriverReconciliation["failures"],
): boolean {
  if (!node.children?.length) {
    if (!allowedLeaves.has(node.id) && !allowedLeaves.has(node.id.split(":")[0])) {
      // Allow composite ids that reference known leaves as prefix
      const known = [...allowedLeaves].some(
        (id) => node.id === id || node.id.endsWith(`:${id}`) || id.endsWith(`:${node.id}`),
      );
      if (!known) {
        failures.push({
          node_id: node.id,
          expected: 0,
          actual: node.value,
          message: `Leaf '${node.id}' is not a known model input/variable`,
        });
        return false;
      }
    }
    return true;
  }

  let ok = true;
  for (const c of node.children) {
    if (!validateTree(c, allowedLeaves, failures)) ok = false;
  }
  const childVals = node.children.map((c) => c.value);
  if (!reconciles(node.value, childVals)) {
    const sum = childVals.reduce((a, b) => a + b, 0);
    failures.push({
      node_id: node.id,
      expected: node.value,
      actual: sum,
      message: `Parent '${node.id}' (${node.value}) does not reconcile to children sum (${sum})`,
    });
    ok = false;
  }
  return ok;
}

function stripToDriverNode(n: z.infer<typeof reasonedNodeSchema>): DriverTreeNode {
  return {
    id: n.id,
    name: n.name,
    value: n.value,
    ...(n.editable != null ? { editable: n.editable } : {}),
    ...(n.children?.length
      ? { children: n.children.map(stripToDriverNode) }
      : {}),
  };
}

/**
 * LLM proposes a business-sound driver tree; reconciliation gate accepts or falls back.
 */
export async function reasonDriverTree(
  deterministic: DriverTreeResult,
  opts: {
    scenarioAbs: Record<string, number>;
    modelInputIds: string[];
    modelOutputIds: string[];
  },
): Promise<DriverTreeResult & { rationale?: string; grouping?: Array<{ category: string; member_ids: string[]; rationale?: string }>; reconciliation?: DriverReconciliation }> {
  if (!getApiKey()) {
    return {
      ...deterministic,
      rationale: undefined,
      reconciliation: { ok: true, failures: [] },
    };
  }

  const allowedLeaves = new Set([
    ...opts.modelInputIds,
    ...opts.modelOutputIds,
    ...collectLeafIds(deterministic.root),
  ]);

  try {
    const review = await callClaudeStructured({
      purpose: "business_analysis",
      toolName: "reason_driver_tree",
      toolDescription: "Propose a business-sound driver decomposition",
      schema: reasonTreeSchema,
      maxTokens: 3000,
      system: `You restructure a financial driver tree into a business-sound decomposition
(e.g. Revenue = Volume × Price, OpEx = Headcount × Cost/head).
Rules:
- Every leaf id MUST be one of the known model variable ids provided.
- Parent values MUST approximately equal the sum of children (additive decompositions).
- Preserve the root target metric id and value.
- Prefer clear FP&A groupings over mechanical dependency dumps.
- Include brief rationale on non-leaf nodes when helpful.`,
      userMessage: JSON.stringify({
        target_metric: deterministic.target_metric,
        deterministic_tree: deterministic.root,
        known_variables: [...allowedLeaves],
        scenario_values: opts.scenarioAbs,
      }),
    });

    const proposedRoot = stripToDriverNode(review.root);
    // Force root value/id from deterministic
    proposedRoot.id = deterministic.root.id;
    proposedRoot.name = deterministic.root.name;
    proposedRoot.value = deterministic.root.value;

    const failures: DriverReconciliation["failures"] = [];
    const ok = validateTree(proposedRoot, allowedLeaves, failures);
    if (!ok) {
      logger.info(
        `[DriverReasoning] Rejected LLM tree (${failures.length} failures) — falling back`,
      );
      return {
        ...deterministic,
        rationale: review.summary,
        reconciliation: { ok: false, failures },
      };
    }

    return {
      ...deterministic,
      root: proposedRoot,
      rationale: review.summary,
      grouping: review.grouping,
      reconciliation: { ok: true, failures: [] },
    };
  } catch (e) {
    logger.warn(`[DriverReasoning] LLM failed: ${(e as Error).message}`);
    return {
      ...deterministic,
      reconciliation: { ok: false, failures: [{ node_id: "root", expected: 0, actual: 0, message: (e as Error).message }] },
    };
  }
}

/** Add per-bar rationale / groupings without changing Shapley contributions. */
export async function reasonAttribution(
  result: AttributionResult,
): Promise<AttributionResult & { driver_groups?: Array<{ category: string; variable_ids: string[]; rationale?: string }>; rationale?: string }> {
  if (!getApiKey()) return result;

  try {
    const review = await callClaudeStructured({
      purpose: "business_analysis",
      toolName: "reason_attribution",
      toolDescription: "Explain Shapley attribution bars in business terms",
      schema: attributionReasonSchema,
      maxTokens: 2000,
      system: `Explain driver attribution bars in concise FP&A language.
Do NOT change contribution numbers. Group related levers when helpful.`,
      userMessage: JSON.stringify({
        target_metric: result.target_metric,
        total_delta: result.total_delta,
        bars: result.bars,
      }),
    });

    const rationaleById = new Map(
      review.bar_rationales.map((r) => [r.variable_id, r.rationale]),
    );
    const bars: AttributionBar[] = result.bars.map((b) => ({
      ...b,
      ...(rationaleById.has(b.variable_id)
        ? { rationale: rationaleById.get(b.variable_id) }
        : {}),
    }));

    return {
      ...result,
      bars,
      driver_groups: review.driver_groups,
      rationale: review.summary,
    };
  } catch (e) {
    logger.warn(`[DriverReasoning] Attribution rationale failed: ${(e as Error).message}`);
    return result;
  }
}
