import { z } from "zod";
import { refineEgressUrl } from "../connectors/egressGuard.js";

const baseUrlSchema = z
  .string()
  .url()
  .or(z.literal("mock://local"))
  .superRefine((url, ctx) => refineEgressUrl(url, ctx));

export const createConnectionSchema = z.object({
  provider: z.enum(["sap_sac", "anaplan", "oracle_pbcs", "mock"]),
  name: z.string().trim().min(1).max(200),
  base_url: baseUrlSchema,
  auth_kind: z.enum(["oauth2_client_credentials", "api_key"]),
  auth_public: z.record(z.unknown()).default({}),
  /** Client secret or API key — encrypted at rest, never echoed. */
  secret: z.string().min(1),
});

export const updateConnectionSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  base_url: baseUrlSchema.optional(),
  auth_kind: z.enum(["oauth2_client_credentials", "api_key"]).optional(),
  auth_public: z.record(z.unknown()).optional(),
  /** Omit to keep existing secret. */
  secret: z.string().min(1).optional(),
});

/** Unsaved connection config — tested in-memory without persisting. */
export const testConnectionSchema = z.object({
  provider: z.enum(["sap_sac", "anaplan", "oracle_pbcs", "mock"]),
  base_url: baseUrlSchema,
  auth_kind: z.enum(["oauth2_client_credentials", "api_key"]),
  auth_public: z.record(z.unknown()).default({}),
  secret: z.string().min(1),
});

export const importModelSchema = z.object({
  fact_query: z
    .object({
      filters: z.record(z.array(z.string())).optional(),
      pageSize: z.number().int().positive().max(5000).optional(),
      versionMemberId: z.string().optional(),
      timeMemberIds: z.array(z.string()).optional(),
      measureIds: z.array(z.string()).optional(),
      odataFilterRaw: z.string().max(2000).optional(),
      includeSourceAggregates: z.boolean().optional(),
    })
    .default({}),
});

export type CreateConnectionBody = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionBody = z.infer<typeof updateConnectionSchema>;
export type TestConnectionBody = z.infer<typeof testConnectionSchema>;
export type ImportModelBody = z.infer<typeof importModelSchema>;
