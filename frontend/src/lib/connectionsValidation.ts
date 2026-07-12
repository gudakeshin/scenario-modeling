export interface ConnectionFormValues {
  name: string;
  provider: string;
  baseUrl: string;
  authKind: string;
  tokenUrl: string;
  clientId: string;
  secret: string;
  namespaceId: string;
  desBasePath: string;
}

export type ConnectionValidationErrors = Partial<Record<keyof ConnectionFormValues, string>>;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isValidDesBasePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true; // empty → backend default
  return trimmed.startsWith("/") && !/\s/.test(trimmed) && trimmed.length <= 200;
}

export function validateConnection(
  values: ConnectionFormValues,
  options: { editing?: boolean } = {},
): ConnectionValidationErrors {
  const errors: ConnectionValidationErrors = {};
  if (!values.name.trim()) errors.name = "Name is required.";

  if (values.provider === "sap_sac") {
    if (!isHttpsUrl(values.baseUrl)) errors.baseUrl = "SAC base URL must be a valid HTTPS URL.";
    if (values.authKind !== "oauth2_client_credentials") {
      errors.authKind = "SAC connections require OAuth client credentials.";
    }
    if (!isHttpsUrl(values.tokenUrl)) errors.tokenUrl = "Token URL must be a valid HTTPS URL.";
    if (!values.clientId.trim()) errors.clientId = "Client ID is required.";
    if (values.desBasePath.trim() && !isValidDesBasePath(values.desBasePath)) {
      errors.desBasePath = "DES base path must start with / and contain no spaces.";
    }
  } else if (!values.baseUrl.trim()) {
    errors.baseUrl = "Base URL is required.";
  }

  if (!options.editing && !values.secret.trim()) {
    errors.secret = values.authKind === "oauth2_client_credentials"
      ? "Client secret is required."
      : "API key is required.";
  }
  return errors;
}

export function hasConnectionErrors(errors: ConnectionValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}
