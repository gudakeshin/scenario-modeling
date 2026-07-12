import { describe, expect, it } from "vitest";
import { validateConnection } from "./connectionsValidation";

const validSac = {
  name: "Finance SAC",
  provider: "sap_sac",
  baseUrl: "https://tenant.example.com",
  authKind: "oauth2_client_credentials",
  tokenUrl: "https://tenant.example.com/oauth/token",
  clientId: "client",
  secret: "secret",
};

describe("validateConnection", () => {
  it("accepts HTTPS SAC OAuth credentials", () => {
    expect(validateConnection(validSac)).toEqual({});
  });

  it("rejects insecure SAC URLs", () => {
    const errors = validateConnection({
      ...validSac,
      baseUrl: "http://tenant.example.com",
      tokenUrl: "http://tenant.example.com/token",
    });
    expect(errors.baseUrl).toMatch(/HTTPS/);
    expect(errors.tokenUrl).toMatch(/HTTPS/);
  });

  it("allows an empty write-only secret while editing", () => {
    expect(validateConnection({ ...validSac, secret: "" }, { editing: true })).toEqual({});
  });
});
