/**
 * Backend error reporter.
 *
 * Always logs via pino. `SENTRY_DSN` is accepted in config for future use;
 * @sentry/node is not a hard dependency — when ready, soft-require it here.
 */

import { logger } from "./logger.js";
import { config } from "./config.js";

type Extra = Record<string, unknown>;

export function captureException(err: unknown, extra?: Extra): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    {
      err: error,
      sentryConfigured: Boolean(config.SENTRY_DSN),
      ...extra,
    },
    error.message || "Unhandled exception"
  );
  // Future: if (config.SENTRY_DSN) soft-require("@sentry/node") and Sentry.captureException(error)
}

export function captureMessage(message: string, extra?: Extra): void {
  logger.warn({ sentryConfigured: Boolean(config.SENTRY_DSN), ...extra }, message);
}
