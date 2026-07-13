import { describe, expect, it } from "vitest";
import { hasConnectionErrors, validateConnection } from "./connectionsValidation";

const validSac = {
  name: "Finance SAC",
  provider: "sap_sac",
  baseUrl: "https://tenant.example.com",
  authKind: "oauth2_client_credentials",
  tokenUrl: "https://tenant.example.com/oauth/token",
  clientId: "client",
  secret: "secret",
  workspaceId: "",
  namespaceId: "sac",
  desBasePath: "/api/v1/dataexport",
};

const validAnaplan = {
  name: "Finance Anaplan",
  provider: "anaplan",
  baseUrl: "https://api.anaplan.com/2/0",
  authKind: "oauth2_client_credentials",
  tokenUrl: "https://auth.anaplan.com/token/authenticate",
  clientId: "finance@example.com",
  secret: "password",
  workspaceId: "8a81b09a12345678",
  namespaceId: "",
  desBasePath: "",
};

const validMock = {
  name: "Demo",
  provider: "mock",
  baseUrl: "mock://local",
  authKind: "api_key",
  tokenUrl: "",
  clientId: "",
  secret: "key",
  workspaceId: "",
  namespaceId: "",
  desBasePath: "",
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

  it("requires name", () => {
    expect(validateConnection({ ...validSac, name: "" }).name).toMatch(/required/);
  });

  it("requires secret on create", () => {
    expect(validateConnection({ ...validSac, secret: "" }).secret).toMatch(/required/);
  });

  it("allows an empty write-only secret while editing", () => {
    expect(validateConnection({ ...validSac, secret: "" }, { editing: true })).toEqual({});
  });

  it("accepts empty advanced fields (backend defaults)", () => {
    expect(validateConnection({ ...validSac, namespaceId: "", desBasePath: "" })).toEqual({});
  });

  it("rejects malformed DES base path", () => {
    const errors = validateConnection({ ...validSac, desBasePath: "api/v1/dataexport" });
    expect(errors.desBasePath).toMatch(/start with \//);
  });

  it("accepts Anaplan username and password credentials", () => {
    expect(validateConnection(validAnaplan)).toEqual({});
  });

  it("requires an Anaplan workspace ID", () => {
    const errors = validateConnection({ ...validAnaplan, workspaceId: "" });
    expect(errors.workspaceId).toBe("Workspace ID is required.");
  });

  it("rejects invalid Anaplan base and token URLs", () => {
    const errors = validateConnection({
      ...validAnaplan,
      baseUrl: "http://api.anaplan.com/2/0",
      tokenUrl: "not-a-url",
    });
    expect(errors.baseUrl).toMatch(/HTTPS/);
    expect(errors.tokenUrl).toMatch(/HTTPS/);
  });

  it("accepts an Anaplan auth token without OAuth fields", () => {
    expect(validateConnection({
      ...validAnaplan,
      baseUrl: "mock://local",
      authKind: "api_key",
      tokenUrl: "",
      clientId: "",
      secret: "AnaplanAuthToken token",
    })).toEqual({});
  });

  it("allows an empty Anaplan password while editing", () => {
    expect(validateConnection(
      { ...validAnaplan, secret: "" },
      { editing: true },
    )).toEqual({});
  });

  it("uses the Anaplan password validation message", () => {
    expect(validateConnection({ ...validAnaplan, secret: "" }).secret).toBe(
      "Password is required.",
    );
  });

  it("accepts mock provider with mock://local", () => {
    expect(validateConnection(validMock)).toEqual({});
  });

  it("rejects mock with wrong base URL", () => {
    expect(validateConnection({ ...validMock, baseUrl: "https://example.com" }).baseUrl)
      .toMatch(/mock:\/\/local/);
  });
});

describe("hasConnectionErrors", () => {
  it("returns false for empty errors", () => {
    expect(hasConnectionErrors({})).toBe(false);
  });

  it("returns true when any field has an error", () => {
    expect(hasConnectionErrors({ name: "Name is required." })).toBe(true);
  });
});
