import type { Express } from "express";
import type http from "node:http";
import { config } from "./config.js";
import { pool } from "./db/index.js";
import { logger } from "./logger.js";
import { captureException } from "./errorReporter.js";

const SHUTDOWN_FORCE_KILL_MS = 10_000;

let shutdownHandler: ((signal: string) => void) | null = null;

export function requestShutdown(signal: string): void {
  shutdownHandler?.(signal);
}

export function startServer(app: Express): http.Server {
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT }, "API listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutdown signal received, draining connections");

    const forceKill = setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_FORCE_KILL_MS);
    forceKill.unref();

    server.close(async (err) => {
      if (err) {
        logger.error({ err }, "Error while closing HTTP server");
      }
      try {
        await pool.end();
        logger.info("Postgres pool closed");
      } catch (poolErr) {
        logger.error({ err: poolErr }, "Error while closing Postgres pool");
      }
      clearTimeout(forceKill);
      process.exit(err ? 1 : 0);
    });
  };

  shutdownHandler = shutdown;

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    captureException(reason, { kind: "unhandledRejection" });
  });

  process.on("uncaughtException", (err) => {
    captureException(err, { kind: "uncaughtException" });
    shutdown("uncaughtException");
  });

  return server;
}
