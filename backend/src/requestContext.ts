import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
