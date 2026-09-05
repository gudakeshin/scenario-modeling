/**
 * Frontend error reporter — console + optional @sentry/nextjs when DSN is set.
 */

type Extra = Record<string, unknown>;

function hasSentryDsn(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

export function captureException(err: unknown, extra?: Extra): void {
  const error = err instanceof Error ? err : new Error(String(err));
  if (hasSentryDsn()) {
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureException(error, { extra });
      })
      .catch(() => {
        console.warn("[errorReporter] Sentry capture failed; logging locally", {
          message: error.message,
          ...extra,
        });
      });
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.error("[errorReporter]", error, extra);
  }
}

export function captureMessage(message: string, extra?: Extra): void {
  if (hasSentryDsn()) {
    import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.captureMessage(message, { extra });
      })
      .catch(() => {
        console.warn("[errorReporter]", message, extra);
      });
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("[errorReporter]", message, extra);
  }
}
