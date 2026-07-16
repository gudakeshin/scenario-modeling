import { z } from "zod";

export const updateContextSchema = z.record(z.unknown());

export const acknowledgeTieOutSchema = z.object({
  note: z.string().max(2000).optional(),
});

export const updateModelSchema = z.object({
  model_definition: z.record(z.unknown()),
});

export const updateModelSchemaEndpointSchema = z.object({
  model_definition: z.record(z.unknown()),
});
