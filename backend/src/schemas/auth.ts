import { z } from "zod";

export const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
  name: z.string().max(255).optional(),
  role: z.enum(["viewer", "analyst", "approver", "admin"]).optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export const logoutSchema = z.object({
  refresh_token: z.string().min(1).optional(),
});

export const updateRoleSchema = z.object({
  role: z.enum(["viewer", "analyst", "approver", "admin"]),
});

export const createScenarioSchema = z.object({
  nl_input: z.string().min(1).max(5000),
  name: z.string().max(255).optional(),
});

export const parseScenarioSchema = z.object({
  nl_input: z.string().min(1).max(5000),
});

export const refineScenarioSchema = z.object({
  nl_input: z.string().min(1).max(5000).optional(),
  answers: z
    .array(
      z.object({
        question_id: z.string().min(1),
        answer: z.string().min(1).max(2000),
        answer_kind: z.enum(["accepted_recommendation", "overridden", "custom", "comment"]).optional(),
        recommended_value: z.string().max(500).optional(),
      })
    )
    .min(1)
    .optional(),
}).refine((b) => !!b.nl_input || (b.answers && b.answers.length > 0), {
  message: "Provide nl_input or answers",
});

export const compareSchema = z.object({
  scenario_ids: z.array(z.string().uuid()).min(1).max(4),
});

export const shareSchema = z.object({
  scenario_id: z.string().uuid(),
  shared_with: z.string().uuid(),
  permission: z.enum(["view", "edit"]).optional(),
});

export const createSessionSchema = z.object({
  scenario_id: z.string().uuid(),
});

export const followUpSchema = z.object({
  nl_input: z.string().min(1).max(5000),
});

export const updateParameterSchema = z
  .object({
    scenario_value: z.coerce.number().finite().optional(),
    status: z.enum(["pending", "accepted", "rejected", "modified"]).optional(),
    override_reason: z.string().max(1000).optional(),
    owner_user_id: z.string().uuid().nullable().optional(),
    source_citation: z.string().max(2000).nullable().optional(),
    rationale: z.string().max(4000).nullable().optional(),
    effective_from: z.string().date().nullable().optional(),
    review_status: z.enum(["draft", "reviewed", "approved", "rejected"]).optional(),
  })
  .refine((b) => Object.values(b).some((value) => value !== undefined), {
    message: "Provide at least one parameter field",
  });

export const lockLeverSchema = z.object({
  lever_id: z.string().min(1).max(255),
  locked: z.boolean().optional(),
});

export const monteCarloSchema = z.object({
  iterations: z.number().int().positive().max(100_000).optional(),
  seed: z.number().int().optional(),
  distributions: z
    .array(
      z.object({
        variable_id: z.string().min(1),
        type: z.enum(["normal", "lognormal", "uniform", "triangular", "pert"]),
        base_value: z.number().finite(),
        stddev: z.number().finite().nonnegative().optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        mode: z.number().finite().optional(),
        delta_type: z.enum(["percent", "absolute", "additive"]).optional(),
        truncate_at_zero: z.boolean().optional(),
      })
    )
    .optional(),
  correlations: z
    .array(
      z
        .object({
          a: z.string().min(1).optional(),
          b: z.string().min(1).optional(),
          rho: z.number().min(-1).max(1).optional(),
          // Legacy aliases
          variable_a: z.string().min(1).optional(),
          variable_b: z.string().min(1).optional(),
          correlation: z.number().min(-1).max(1).optional(),
        })
        .transform((c) => ({
          a: c.a ?? c.variable_a ?? "",
          b: c.b ?? c.variable_b ?? "",
          rho: c.rho ?? c.correlation ?? 0,
        }))
        .pipe(
          z.object({
            a: z.string().min(1),
            b: z.string().min(1),
            rho: z.number().min(-1).max(1),
          }),
        ),
    )
    .optional(),
  /** Historical samples keyed by variable_id — used to fit distributions + correlations. */
  historical_samples: z.record(z.string(), z.array(z.number().finite())).optional(),
});

export const sensitivitySchema = z.object({
  target_metric: z.string().min(1).max(255).optional(),
  swing_pct: z.number().positive().max(100).optional(),
  percent_swing_pp: z.number().positive().max(100).optional(),
});

export const twoWaySensitivitySchema = z.object({
  target_metric: z.string().min(1).max(255).optional(),
  variable_a: z.string().min(1),
  variable_b: z.string().min(1),
  swings: z.array(z.number().finite()).min(2).max(21).optional(),
  swing_by_variable: z.record(z.string(), z.array(z.number().finite())).optional(),
  percent_swing_pp: z.number().positive().max(100).optional(),
});

export const attributionSchema = z.object({
  target_metric: z.string().min(1).max(255).optional(),
  /** When true, LLM adds business rationale / groupings (Shapley math unchanged). */
  reason: z.boolean().optional(),
});

export const goalSeekSchema = z.object({
  target_metric: z.string().min(1).max(255).optional(),
  target_value: z.number().finite(),
  variable_id: z.string().min(1).max(255),
  low: z.number().finite().optional(),
  high: z.number().finite().optional(),
  tolerance: z.number().positive().optional(),
});

export const driverTreeSchema = z.object({
  metric: z.string().min(1).max(255).optional(),
  target_metric: z.string().min(1).max(255).optional(),
  /** When true, LLM restructures the tree (reconciliation-gated). */
  reason: z.boolean().optional(),
  /** Optional lever edits applied before returning the tree. */
  apply_levers: z
    .array(
      z.object({
        variable_id: z.string().min(1).max(255),
        scenario_value: z.coerce.number().finite(),
        delta_type: z.enum(["percent", "absolute", "additive"]).optional(),
      }),
    )
    .max(50)
    .optional(),
});

export const fidelityAuditSchema = z.object({
  /** Optional P&L override; otherwise uses latest simulation aggregate. */
  pl: z.record(z.number()).optional(),
});

export const applyLeverSchema = z.object({
  variable_id: z.string().min(1).max(255),
  scenario_value: z.coerce.number().finite(),
  delta_type: z.enum(["percent", "absolute", "additive"]).optional(),
  reason: z.string().max(1000).optional(),
  status: z.enum(["pending", "accepted", "modified"]).optional(),
});
