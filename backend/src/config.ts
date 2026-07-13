import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters"),
  JWT_ISSUER: z.string().default("scenario-modeling"),
  JWT_AUDIENCE: z.string().default("scenario-modeling-api"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(604_800),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  ANTHROPIC_MODEL_PARSE: z.string().optional(),
  /** Defaults to Sonnet 5 when unset — analysis / context_build quality tier. */
  ANTHROPIC_MODEL_ANALYSIS: z.string().optional(),
  /** Defaults to Opus 4.8 when unset — QA judge / agentic reasoner tier. */
  ANTHROPIC_MODEL_QA: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_MODEL: z.string().default("sonar"),
  LLAMA_CLOUD_API_KEY: z.string().optional(),
  LLAMA_PARSE_CSV: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  // Deprecated — kept optional for migration; document ingest no longer uses Qdrant
  QDRANT_URL: z.string().optional(),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.string().optional(),
  // Embedding: "none" = keyword search only (default); "openai" = OpenAI-compatible API
  EMBEDDING_PROVIDER: z.enum(["openai", "none"]).default("none"),
  EMBEDDING_API_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  SESSION_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Optional Redis URL for shared session/context cache (horizontal scale). */
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : undefined)),
  /** S3-compatible object storage for workbook bytes (optional). */
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  OBJECT_STORAGE_REGION: z.string().default("us-east-1"),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /** OIDC (optional — AUTH_PROVIDER=oidc) */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_AUDIENCE: z.string().optional(),
  /** Registered callback URL, e.g. http://localhost:4000/api/v1/auth/oidc/callback */
  OIDC_REDIRECT_URI: z.string().url().optional(),
  /** Optional IdP authorize/token overrides (defaults: issuer + standard paths). */
  OIDC_AUTHORIZATION_ENDPOINT: z.string().url().optional(),
  OIDC_TOKEN_ENDPOINT: z.string().url().optional(),
  AUTH_PROVIDER: z.enum(["local", "oidc"]).default("local"),
  /** Optional — Sentry DSN; SDK soft-loaded when set. */
  SENTRY_DSN: z.string().optional(),
  MAX_INPUT_LENGTH: z.coerce.number().int().positive().default(2000),
  DEMO_MODE: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  ENABLE_PLANNING_CONNECTORS: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /** 64 hex chars (32 bytes) for AES-256-GCM; required when ENABLE_PLANNING_CONNECTORS is on. */
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional(),
  EXTERNAL_MODEL_MAX_CELLS: z.coerce.number().int().positive().default(500_000),
  SAC_DEFAULT_PAGE_SIZE: z.coerce.number().int().positive().default(1000),
  SAC_MAX_FACT_PAGES: z.coerce.number().int().positive().default(10_000),
  SAC_HTTP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),
  ANAPLAN_HTTP_MAX_RETRIES: z.coerce.number().int().nonnegative().default(4),
  ANAPLAN_MAX_MODULES_PER_MODEL: z.coerce.number().int().positive().default(100),
  ANAPLAN_READ_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1500),
  ANAPLAN_READ_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /** Absolute / relative absurdity threshold (%) for simulation notices. */
  ABSURDITY_THRESHOLD_PCT: z.coerce.number().positive().default(200),
  /** Cross-foot / identity-repair relative tolerance (fraction, e.g. 0.01 = 1%). */
  IDENTITY_REPAIR_TOLERANCE: z.coerce.number().positive().default(0.01),
  /** Fidelity reconciliation absolute tolerance (canonical units). */
  FIDELITY_ABS_TOLERANCE: z.coerce.number().nonnegative().default(0.5),
  /** Fidelity reconciliation relative tolerance (fraction). */
  FIDELITY_REL_TOLERANCE: z.coerce.number().positive().default(0.01),
  /** Minimum fidelity score (0–1) required for validation_status=ready. */
  FIDELITY_READY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
  MC_DEFAULT_PERCENT_SPREAD_PP: z.coerce.number().positive().default(5),
  MC_DEFAULT_RELATIVE_STDDEV: z.coerce.number().positive().default(0.1),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  GOAL_SEEK_MAX_ITERATIONS: z.coerce.number().int().positive().default(40),
  /** When true, residual invariant violations invoke the LLM accounting-fidelity agent. */
  FIDELITY_AGENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  SHOWCASE_AGENT_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "1" || v?.toLowerCase() === "true"),
  /**
   * Deployment profile for showcase capabilities.
   * - standard: core FP&A (agent off unless SHOWCASE_AGENT_ENABLED)
   * - showcase: enables agentic reasoning + hybrid RAG expectations
   * - enterprise: showcase + Redis/OIDC/object-store oriented defaults
   */
  DEPLOYMENT_PROFILE: z.enum(["standard", "showcase", "enterprise"]).default("standard"),
});

const DEFAULT_ANALYSIS_MODEL = "claude-sonnet-5";
const DEFAULT_QA_MODEL = "claude-opus-4-8";

export type AppConfig = z.infer<typeof envSchema> & {
  anthropicModelParse: string;
  anthropicModelAnalysis: string;
  anthropicModelQa: string;
};

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid configuration:\n${details}`);
    process.exit(1);
  }
  const env = parsed.data;
  if (env.NODE_ENV === "production" && !env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required in production");
    process.exit(1);
  }
  if (env.EMBEDDING_PROVIDER === "openai" && (!env.EMBEDDING_API_URL || !env.EMBEDDING_API_KEY)) {
    console.error("EMBEDDING_PROVIDER=openai requires EMBEDDING_API_URL and EMBEDDING_API_KEY");
    process.exit(1);
  }
  if (env.ENABLE_PLANNING_CONNECTORS) {
    const key = env.CREDENTIALS_ENCRYPTION_KEY;
    if (!key || key.length !== 64 || !/^[0-9a-fA-F]+$/.test(key)) {
      console.error(
        "ENABLE_PLANNING_CONNECTORS requires CREDENTIALS_ENCRYPTION_KEY (64 hex characters)",
      );
      process.exit(1);
    }
  }
  return {
    ...env,
    anthropicModelParse: env.ANTHROPIC_MODEL_PARSE || env.ANTHROPIC_MODEL,
    anthropicModelAnalysis: env.ANTHROPIC_MODEL_ANALYSIS || DEFAULT_ANALYSIS_MODEL,
    anthropicModelQa: env.ANTHROPIC_MODEL_QA || DEFAULT_QA_MODEL,
  };
}

export const config = loadConfig();

/** Feature gate for planning-system connectors (SAP SAC first). */
export function isPlanningConnectorsEnabled(): boolean {
  const fromEnv = process.env.ENABLE_PLANNING_CONNECTORS;
  if (fromEnv === "1" || fromEnv?.toLowerCase() === "true") return true;
  return !!config.ENABLE_PLANNING_CONNECTORS;
}
