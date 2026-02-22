import "dotenv/config";
import express from "express";
import cors from "cors";
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
import { requireRole } from "./middleware/rbac.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000" }));
app.use(express.json());

// Rate limiting: simple in-memory limiter (configurable via env)
const RATE_WINDOW = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 120;
const rateLimitMap = new Map<string, { count: number; reset: number }>();
app.use((req, res, next) => {
  const key = (req.headers["x-user-id"] as string) || req.ip || "anon";
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.reset) {
    rateLimitMap.set(key, { count: 1, reset: now + RATE_WINDOW });
    return next();
  }
  entry.count++;
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
  }
  next();
});

// Input size limit (JSON bodies; file uploads handled by multer)
app.use(express.json({ limit: "5mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "scenario-modeling-api" });
});

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

// Export app for integration testing (supertest)
export { app };

const port = Number(process.env.PORT) || 4000;
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    console.log(`API listening on http://localhost:${port}`);
  });
}
