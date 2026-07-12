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
  ANTHROPIC_MODEL_ANALYSIS: z.string().optional(),
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
  AUTH_PROVIDER: z.enum(["local"]).default("local"),
  /** Optional — reserved for future Sentry; see errorReporter.ts (no hard @sentry/node dep yet). */
  SENTRY_DSN: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema> & {
  anthropicModelParse: string;
  anthropicModelAnalysis: string;
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
    anthropicModelAnalysis: env.ANTHROPIC_MODEL_ANALYSIS || env.ANTHROPIC_MODEL,
  };
}

export const config = loadConfig();

/** Feature gate for planning-system connectors (SAP SAC first). */
export function isPlanningConnectorsEnabled(): boolean {
  const fromEnv = process.env.ENABLE_PLANNING_CONNECTORS;
  if (fromEnv === "1" || fromEnv?.toLowerCase() === "true") return true;
  return !!config.ENABLE_PLANNING_CONNECTORS;
}
