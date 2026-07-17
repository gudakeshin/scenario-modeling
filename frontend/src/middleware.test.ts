import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function req(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

describe("middleware auth guard", () => {
  it("redirects unauthenticated dashboard requests to login", () => {
    const res = proxy(req("/dashboard"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?next=%2Fdashboard");
  });

  it("allows protected routes with sm_session cookie", () => {
    const res = proxy(req("/dashboard", "sm_session=1"));
    expect(res.status).toBe(200);
  });
});
