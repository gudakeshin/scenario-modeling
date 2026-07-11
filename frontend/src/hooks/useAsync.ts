"use client";

import { useCallback, useRef, useState } from "react";
import { captureException } from "@/lib/errorReporter";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  run: (...args: unknown[]) => Promise<T | null>;
  reset: () => void;
}

/**
 * Lightweight async state: `{ data, error, loading, run }`.
 * Pass a factory that returns a Promise; call `run(...args)` to execute.
 */
export function useAsync<T, Args extends unknown[] = []>(
  fn: (...args: Args) => Promise<T>
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const run = useCallback(async (...args: unknown[]) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fnRef.current(...(args as Args));
      setData(result);
      setLoading(false);
      return result;
    } catch (e) {
      const err = e as Error;
      captureException(err);
      setError(err.message || "Request failed");
      setLoading(false);
      return null;
    }
  }, []) as AsyncState<T>["run"];

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  return { data, error, loading, run, reset };
}
