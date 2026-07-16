import { z } from "zod";

export const createTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  parameter_set: z.record(z.unknown()),
  model_version_hash: z.string().max(64).optional(),
  is_shared: z.boolean().optional(),
  sharing_scope: z.string().max(50).optional(),
});

export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).optional(),
  parameter_set: z.record(z.unknown()).optional(),
  model_version_hash: z.string().max(64).optional(),
  is_shared: z.boolean().optional(),
  sharing_scope: z.string().max(50).optional(),
});

export const cloneTemplateSchema = z.object({
  nl_input: z.string().max(5000).optional(),
});

export const saveScenarioAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).optional(),
  is_shared: z.boolean().optional(),
});

export const listTemplatesQuerySchema = z.object({
  scope: z.string().max(50).optional(),
});
