import { config } from "./config.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { httpLogger, logger } from "./logger.js";
import { httpRequestDuration, registry } from "./metrics.js";
import { pool } from "./db/index.js";
import { requestContext } from "./requestContext.js";
import { scenariosRouter } from "./routes/scenarios.js";
import { mappingsRouter } from "./routes/mappings.js";
import { auditRouter } from "./routes/audit.js";
import { exportsRouter } from "./routes/exports.js";
import { usersRouter } from "./routes/users.js";
import { analysisRouter } from "./routes/monteCarlo.js";
import { templatesRouter } from "./routes/templates.js";
import { sessionsRouter } from "./routes/sessions.js";
import { documentsRouter } from "./routes/documents.js";
import { contextRouter } from "./routes/context.js";
import { authRouter } from "./routes/auth.js";
import { authenticate } from "./auth/middleware.js";
import { requireRole } from "./middleware/rbac.js";
import { resolveWorkspace } from "./middleware/workspace.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { startServer } from "./server.js";

const app = express();

app.set("trust proxy", 1);
app.use(helmet());
app.use(httpLogger);

// Propagate pino-http request id + client meta for audit hashing.
app.use((req, res, next) => {
  const id = (req as { id?: string }).id;
  requestContext.run(
    {
      requestId: id ? String(id) : undefined,
      ip: req.ip,
      userAgent: req.get("user-agent") || undefined,
    },
    next,
  );
});

// Prometheus HTTP duration (skip probes / metrics scrape).
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/ready" || req.path === "/metrics") {
    return next();
  }
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route = req.route?.path
      ? `${req.baseUrl}${req.route.path}`
      : req.path;
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
});

app.use(
  cors({
    origin: config.FRONTEND_ORIGIN,
    credentials: true,
  })
);
app.use(express.json({ limit: "5mb" }));

const authLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many auth attempts. Try again later." },
});

const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || req.ip || "anon",
  validate: { keyGeneratorIpFallback: false },
  message: { error: "Rate limit exceeded. Try again in a minute." },
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "scenario-modeling-api" });
});

app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch (err) {
    logger.error({ err }, "Readiness check failed: Postgres unreachable");
    res.status(503).json({ status: "not_ready", reason: "database_unreachable" });
  }
});

app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

app.use("/api/v1/auth", authLimiter, authRouter);

// All other API routes require authentication and an active workspace scope
app.use("/api/v1", authenticate, resolveWorkspace, apiLimiter);

app.use("/api/v1/workspaces", workspacesRouter);
app.use("/api/v1/scenarios", scenariosRouter);
app.use("/api/v1/scenarios", exportsRouter);
app.use("/api/v1/mappings", requireRole("analyst"), mappingsRouter);
app.use("/api/v1/audit", auditRouter);
app.use("/api/v1/users", usersRouter);
app.use("/api/v1/scenarios", analysisRouter);
app.use("/api/v1/templates", templatesRouter);
app.use("/api/v1/sessions", sessionsRouter);
app.use("/api/v1/documents", documentsRouter);
app.use("/api/v1/context", contextRouter);

export { app };

if (config.NODE_ENV !== "test") {
  startServer(app);
}
