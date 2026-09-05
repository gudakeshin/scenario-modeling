/**
 * Minimal Server-Sent Events helpers for progress streaming endpoints.
 */

import type { Request, Response } from "express";

export function initSse(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

export function sendSse(
  res: Response,
  event: string,
  data: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function endSse(res: Response): void {
  if (!res.writableEnded) {
    res.write("event: end\ndata: {}\n\n");
    res.end();
  }
}

/** True when the client asked for an event stream (Accept header or ?stream=1). */
export function wantsSse(req: Request): boolean {
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) return true;
  const stream = req.query.stream;
  return stream === "1" || stream === "true";
}

/** Wire client disconnect / abort so long-running streams can stop work. */
export function onSseAbort(req: Request, res: Response, onAbort: () => void): void {
  let aborted = false;
  const fire = () => {
    if (aborted) return;
    aborted = true;
    onAbort();
  };
  req.on("close", fire);
  req.on("aborted", fire);
  res.on("close", fire);
}

export function isSseWritable(res: Response): boolean {
  return !res.writableEnded && !res.destroyed;
}
