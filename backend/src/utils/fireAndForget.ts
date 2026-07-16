import { logger } from "../logger.js";
import { captureException } from "../errorReporter.js";

/** Attach a logging catch to fire-and-forget promises. */
export function fireAndForget(promise: Promise<unknown>, ctx: string): void {
  void promise.catch((err: unknown) => {
    logger.error({ err, ctx }, "Fire-and-forget promise rejected");
    captureException(err, { ctx });
  });
}
