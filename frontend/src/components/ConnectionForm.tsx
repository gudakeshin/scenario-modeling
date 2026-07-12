"use client";

import { useEffect, useState } from "react";
import {
  createConnection,
  updateConnection,
  type PlanningConnection,
} from "@/lib/api";
import {
  hasConnectionErrors,
  validateConnection,
  type ConnectionFormValues,
  type ConnectionValidationErrors,
} from "@/lib/connectionsValidation";

interface Props {
  connection?: PlanningConnection | null;
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}

const emptyValues: ConnectionFormValues = {
  name: "",
  provider: "mock",
  baseUrl: "mock://local",
  authKind: "api_key",
  tokenUrl: "",
  clientId: "",
  secret: "",
};

export function ConnectionForm({ connection, onSaved, onCancel }: Props) {
  const editing = Boolean(connection);
  const [values, setValues] = useState<ConnectionFormValues>(emptyValues);
  const [errors, setErrors] = useState<ConnectionValidationErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!connection) {
      setValues(emptyValues);
      return;
    }
    setValues({
      name: connection.name,
      provider: connection.provider,
      baseUrl: connection.base_url,
      authKind: connection.auth_kind,
      tokenUrl: String(connection.auth_public?.token_url ?? ""),
      clientId: String(connection.auth_public?.client_id ?? ""),
      secret: "",
    });
  }, [connection]);

  const set = (field: keyof ConnectionFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const changeProvider = (provider: string) => {
    setValues((current) => provider === "sap_sac"
      ? { ...current, provider, baseUrl: "https://", authKind: "oauth2_client_credentials" }
      : { ...current, provider, baseUrl: "mock://local", authKind: "api_key", tokenUrl: "", clientId: "" });
    setErrors({});
  };

  const submit = async () => {
    const nextErrors = validateConnection(values, { editing });
    setErrors(nextErrors);
    if (hasConnectionErrors(nextErrors)) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const auth_public = values.authKind === "oauth2_client_credentials"
        ? { token_url: values.tokenUrl.trim(), client_id: values.clientId.trim() }
        : {};
      if (connection) {
        await updateConnection(connection.connection_id, {
          name: values.name.trim(),
          base_url: values.baseUrl.trim(),
          auth_kind: values.authKind,
          auth_public,
          ...(values.secret.trim() ? { secret: values.secret } : {}),
        });
      } else {
        await createConnection({
          provider: values.provider,
          name: values.name.trim(),
          base_url: values.baseUrl.trim(),
          auth_kind: values.authKind,
          auth_public,
          secret: values.secret,
        });
      }
      await onSaved();
    } catch (error) {
      setSubmitError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const field = (
    key: keyof ConnectionFormValues,
    placeholder: string,
    type = "text",
  ) => (
    <label className="block">
      <span className="sr-only">{placeholder}</span>
      <input
        type={type}
        className="w-full text-sm rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1.5"
        placeholder={placeholder}
        value={values[key]}
        onChange={(event) => set(key, event.target.value)}
        autoComplete={type === "password" ? "new-password" : undefined}
      />
      {errors[key] && <span className="text-[11px] text-[var(--danger)]">{errors[key]}</span>}
    </label>
  );

  return (
    <div className="border border-[var(--border)] rounded-lg p-3 space-y-2 bg-[var(--panel-bg)]">
      {field("name", "Name")}
      <label className="block">
        <span className="sr-only">Provider</span>
        <select
          disabled={editing}
          className="w-full text-sm rounded-md border border-[var(--border)] bg-[var(--card-bg)] px-2 py-1.5 disabled:opacity-60"
          value={values.provider}
          onChange={(event) => changeProvider(event.target.value)}
        >
          <option value="mock">Mock (demo / CI)</option>
          <option value="sap_sac">SAP Analytics Cloud</option>
        </select>
      </label>
      {field("baseUrl", "Base URL")}
      {values.authKind === "oauth2_client_credentials" && (
        <>
          {field("tokenUrl", "Token URL")}
          {field("clientId", "Client ID")}
        </>
      )}
      {field(
        "secret",
        editing
          ? "New secret (leave blank to keep current)"
          : values.authKind === "api_key" ? "API key (write-only)" : "Client secret (write-only)",
        "password",
      )}
      {submitError && <p className="text-xs text-[var(--danger)]">{submitError}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={submit}
          className="flex-1 rounded-md bg-accent text-white text-sm font-medium py-1.5 disabled:opacity-40"
        >
          {saving ? "Saving…" : editing ? "Save changes" : "Create connection"}
        </button>
        <button type="button" onClick={onCancel} className="px-3 text-xs text-[var(--text-muted)]">
          Cancel
        </button>
      </div>
    </div>
  );
}
