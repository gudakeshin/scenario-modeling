/**
 * Frontend error reporter.
 *
 * Default: no-op beyond console in development.
 * If `NEXT_PUBLIC_SENTRY_DSN` is set, logs a stub note — @sentry/nextjs is not
 * bundled by default; wire it when ready.
 */

type Extra = Record<string, unknown>;

function hasSentryDsn(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

export function captureException(err: unknown, extra?: Extra): void {
  const error = err instanceof Error ? err : new Error(String(err));
  if (hasSentryDsn()) {
    // Sentry SDK not bundled yet — structured console stub so DSN wiring is visible.
    console.warn("[errorReporter] Sentry DSN set but @sentry/nextjs not bundled; logging locally", {
      message: error.message,
      stack: error.stack,
      ...extra,
    });
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.error("[errorReporter]", error, extra);
  }
}

export function captureMessage(message: string, extra?: Extra): void {
  if (hasSentryDsn()) {
    console.warn("[errorReporter] Sentry DSN set but @sentry/nextjs not bundled:", message, extra);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    console.warn("[errorReporter]", message, extra);
  }
}
