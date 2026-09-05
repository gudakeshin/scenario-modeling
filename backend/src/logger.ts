import pino from "pino";
import { pinoHttp } from "pino-http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export const logger = pino({
  level: config.NODE_ENV === "test" ? "silent" : process.env.LOG_LEVEL || "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.password_hash",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[REDACTED]",
  },
});

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    const existing = req.headers["x-request-id"];
    const id = (Array.isArray(existing) ? existing[0] : existing) || randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  autoLogging: {
    ignore: (req: IncomingMessage) =>
      req.url === "/health" || req.url === "/ready" || req.url === "/metrics",
  },
});
