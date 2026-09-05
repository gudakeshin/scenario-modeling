/**
 * Backend error reporter — pino + optional Sentry when SENTRY_DSN is set.
 */

import { logger } from "./logger.js";
import { config } from "./config.js";

type Extra = Record<string, unknown>;

let sentryInitialized = false;

export async function initSentry(): Promise<void> {
  if (!config.SENTRY_DSN || sentryInitialized) return;
  try {
    const Sentry = await import("@sentry/node");
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.NODE_ENV,
      tracesSampleRate: config.NODE_ENV === "production" ? 0.1 : 1.0,
      beforeSend(event) {
        // Scrub obvious PII
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        return event;
      },
    });
    sentryInitialized = true;
    logger.info("[Sentry] Initialized");
  } catch (e) {
    logger.warn({ detail: (e as Error).message }, "[Sentry] Failed to initialize");
  }
}

export function captureException(err: unknown, extra?: Extra): void {
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error(
    {
      err: error,
      sentryConfigured: Boolean(config.SENTRY_DSN),
      ...extra,
    },
    error.message || "Unhandled exception",
  );
  if (config.SENTRY_DSN) {
    import("@sentry/node")
      .then((Sentry) => {
        Sentry.withScope((scope) => {
          if (extra) {
            for (const [k, v] of Object.entries(extra)) {
              scope.setExtra(k, v);
            }
          }
          Sentry.captureException(error);
        });
      })
      .catch(() => undefined);
  }
}

export function captureMessage(message: string, extra?: Extra): void {
  logger.warn({ sentryConfigured: Boolean(config.SENTRY_DSN), ...extra }, message);
  if (config.SENTRY_DSN) {
    import("@sentry/node")
      .then((Sentry) => {
        Sentry.withScope((scope) => {
          if (extra) {
            for (const [k, v] of Object.entries(extra)) {
              scope.setExtra(k, v);
            }
          }
          Sentry.captureMessage(message);
        });
      })
      .catch(() => undefined);
  }
}
