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
  refresh_token: z.string().min(1),
});

export const logoutSchema = z.object({
  refresh_token: z.string().min(1),
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
  })
  .refine((b) => b.scenario_value !== undefined || b.status !== undefined, {
    message: "Provide scenario_value and/or status",
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
        delta_type: z.enum(["percent", "absolute"]).optional(),
      })
    )
    .optional(),
  correlations: z
    .array(
      z.object({
        variable_a: z.string().min(1),
        variable_b: z.string().min(1),
        correlation: z.number().min(-1).max(1),
      })
    )
    .optional(),
});

export const sensitivitySchema = z.object({
  target_metric: z.string().min(1).max(255).optional(),
  swing_pct: z.number().positive().max(100).optional(),
});
