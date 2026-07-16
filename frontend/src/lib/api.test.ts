import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  apiFetch,
  ApiTimeoutError,
  setTokens,
  clearTokens,
  getAccessToken,
} from "./api";

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    clearTokens();
    // Avoid jsdom navigating away on failed refresh.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/app", search: "", href: "http://localhost/app" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    clearTokens();
  });

  it("throws ApiTimeoutError when the request aborts due to timeout", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(apiFetch("http://localhost:4000/api/v1/scenarios", {}, 50)).rejects.toBeInstanceOf(
      ApiTimeoutError
    );
    await expect(apiFetch("http://localhost:4000/api/v1/scenarios", {}, 50)).rejects.toThrow(
      /timed out after 0\.05s/i
    );
  });

  it("honors timeoutMs on the init object (LLM callers)", async () => {
    vi.mocked(fetch).mockImplementation((_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    await expect(
      apiFetch("http://localhost:4000/api/v1/scenarios/x/business-analysis", {
        method: "POST",
        timeoutMs: 75,
      })
    ).rejects.toThrow(/timed out after 0\.075s/i);
  });

  it("refreshes tokens and retries once on 401", async () => {
    setTokens("expired-access");

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const res = await apiFetch("http://localhost:4000/api/v1/scenarios");
    expect(res.status).toBe(200);
    expect(getAccessToken()).toBe("new-access");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshCall = fetchMock.mock.calls[1];
    expect(String(refreshCall[0])).toContain("/api/v1/auth/refresh");
    expect(refreshCall[1]?.method).toBe("POST");

    const retryCall = fetchMock.mock.calls[2];
    const retryHeaders = new Headers(retryCall[1]?.headers as HeadersInit);
    expect(retryHeaders.get("Authorization")).toBe("Bearer new-access");
  });

  it("clears tokens and redirects to login when refresh fails after 401", async () => {
    setTokens("expired-access");

    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }));

    const res = await apiFetch("http://localhost:4000/api/v1/users/me");
    expect(res.status).toBe(401);
    expect(getAccessToken()).toBeNull();
    expect(window.location.href).toMatch(/^\/login\?next=/);
  });
});
