"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  createConnection,
  testConnectionDraft,
  updateConnection,
  type PlanningConnection,
} from "@/lib/api";
import {
  hasConnectionErrors,
  validateConnection,
  type ConnectionFormValues,
  type ConnectionValidationErrors,
} from "@/lib/connectionsValidation";
import { ProviderPicker, type ProviderId } from "./ProviderPicker";

interface ConnectionDrawerProps {
  open: boolean;
  connection?: PlanningConnection | null;
  onClose: () => void;
  onSaved: (connectionId?: string) => void;
  onBrowse?: () => void;
}

const emptyValues: ConnectionFormValues = {
  name: "",
  provider: "sap_sac",
  baseUrl: "https://",
  authKind: "oauth2_client_credentials",
  tokenUrl: "",
  clientId: "",
  secret: "",
  namespaceId: "sac",
  desBasePath: "/api/v1/dataexport",
};

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
      {children}
      {hint && !error && <span className="block text-[11px] text-[var(--text-muted)]">{hint}</span>}
      {error && <span className="block text-[11px] text-[var(--danger)]">{error}</span>}
    </label>
  );
}

export function ConnectionDrawer({
  open,
  connection,
  onClose,
  onSaved,
  onBrowse,
}: ConnectionDrawerProps) {
  const editing = Boolean(connection);
  const [values, setValues] = useState<ConnectionFormValues>(emptyValues);
  const [errors, setErrors] = useState<ConnectionValidationErrors>({});
  const [advanced, setAdvanced] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    if (!connection) {
      setValues(emptyValues);
      setAdvanced(false);
    } else {
      const pub = connection.auth_public || {};
      setValues({
        name: connection.name,
        provider: connection.provider,
        baseUrl: connection.base_url,
        authKind: connection.auth_kind,
        tokenUrl: String(pub.token_url ?? ""),
        clientId: String(pub.client_id ?? ""),
        secret: "",
        namespaceId: String(pub.namespace_id ?? "sac"),
        desBasePath: String(pub.des_base_path ?? "/api/v1/dataexport"),
      });
      setAdvanced(Boolean(pub.namespace_id || pub.des_base_path));
    }
    setErrors({});
    setTestResult(null);
  }, [open, connection]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const set = (field: keyof ConnectionFormValues, value: string) => {
    setValues((c) => ({ ...c, [field]: value }));
    setErrors((c) => ({ ...c, [field]: undefined }));
    setTestResult(null);
  };

  const changeProvider = (provider: ProviderId) => {
    if (editing) return;
    setValues((c) =>
      provider === "sap_sac"
        ? {
            ...c,
            provider,
            baseUrl: "https://",
            authKind: "oauth2_client_credentials",
            namespaceId: "sac",
            desBasePath: "/api/v1/dataexport",
          }
        : {
            ...c,
            provider,
            baseUrl: "mock://local",
            authKind: "api_key",
            tokenUrl: "",
            clientId: "",
            namespaceId: "",
            desBasePath: "",
          },
    );
    setErrors({});
    setTestResult(null);
  };

  const buildAuthPublic = (): Record<string, unknown> => {
    if (values.authKind !== "oauth2_client_credentials") return {};
    return {
      token_url: values.tokenUrl.trim(),
      client_id: values.clientId.trim(),
      namespace_id: values.namespaceId.trim() || "sac",
      des_base_path: values.desBasePath.trim() || "/api/v1/dataexport",
    };
  };

  const draftBody = () => ({
    provider: values.provider,
    base_url: values.baseUrl.trim(),
    auth_kind: values.authKind,
    auth_public: buildAuthPublic(),
    secret: values.secret || "placeholder-for-edit-test",
  });

  const runTest = async () => {
    const nextErrors = validateConnection(values, { editing: editing && !values.secret.trim() });
    // For edit without new secret, draft-test still needs a secret — skip draft and note
    if (editing && !values.secret.trim()) {
      setTestResult({
        ok: false,
        message: "Enter the client secret to test before saving, or save first and use Test on the card.",
      });
      return;
    }
    setErrors(nextErrors);
    if (hasConnectionErrors(nextErrors)) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnectionDraft(draftBody());
      setTestResult(result);
      if (result.ok) toast.success(result.message || "Connected");
      else toast.error(result.message || "Connection test failed");
    } catch (e) {
      const message = (e as Error).message;
      setTestResult({ ok: false, message });
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    const nextErrors = validateConnection(values, { editing });
    setErrors(nextErrors);
    if (hasConnectionErrors(nextErrors)) return;
    setSaving(true);
    try {
      const auth_public = buildAuthPublic();
      if (connection) {
        await updateConnection(connection.connection_id, {
          name: values.name.trim(),
          base_url: values.baseUrl.trim(),
          auth_kind: values.authKind,
          auth_public,
          ...(values.secret.trim() ? { secret: values.secret } : {}),
        });
        toast.success("Connection updated");
        onSaved(connection.connection_id);
      } else {
        const created = await createConnection({
          provider: values.provider,
          name: values.name.trim(),
          base_url: values.baseUrl.trim(),
          auth_kind: values.authKind,
          auth_public,
          secret: values.secret,
        });
        toast.success("Connection saved");
        onSaved(created.connection_id);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--card-bg)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-faint)] outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/20";

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--card-bg)] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 id={titleId} className="text-base font-semibold text-[var(--text-primary)]">
            {editing ? "Edit connection" : "Connect a system"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--panel-bg)]"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <Field label="Name" error={errors.name}>
            <input
              className={inputClass}
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. SAP-Prod"
            />
          </Field>

          <div>
            <p className="mb-2 text-xs font-medium text-[var(--text-primary)]">Provider</p>
            <ProviderPicker value={values.provider} onChange={changeProvider} disabled={editing} />
          </div>

          {values.provider === "sap_sac" ? (
            <>
              <Field
                label="Tenant base URL"
                hint="Where to find: SAC tenant URL without /api/v1/dataexport"
                error={errors.baseUrl}
              >
                <input
                  className={inputClass}
                  value={values.baseUrl}
                  onChange={(e) => set("baseUrl", e.target.value)}
                  placeholder="https://your-tenant.sapanalytics.cloud"
                />
              </Field>
              <Field
                label="Token URL"
                hint="Where to find: OAuth token endpoint from your IdP / SAC"
                error={errors.tokenUrl}
              >
                <input
                  className={inputClass}
                  value={values.tokenUrl}
                  onChange={(e) => set("tokenUrl", e.target.value)}
                  placeholder="https://…/oauth/token"
                />
              </Field>
              <Field label="Client ID" hint="Where to find: OAuth client app registration" error={errors.clientId}>
                <input
                  className={inputClass}
                  value={values.clientId}
                  onChange={(e) => set("clientId", e.target.value)}
                />
              </Field>
              <Field
                label={editing ? "Client secret (leave blank to keep)" : "Client secret"}
                hint="Write-only — never shown again after save"
                error={errors.secret}
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  value={values.secret}
                  onChange={(e) => set("secret", e.target.value)}
                />
              </Field>

              <button
                type="button"
                onClick={() => setAdvanced((v) => !v)}
                className="text-xs font-medium text-[var(--accent-text)]"
              >
                {advanced ? "Hide advanced" : "Advanced (namespace & DES path)"}
              </button>
              {advanced && (
                <div className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-3">
                  <Field
                    label="Namespace ID"
                    hint="Default: sac — override for non-default tenants"
                  >
                    <input
                      className={inputClass}
                      value={values.namespaceId}
                      onChange={(e) => set("namespaceId", e.target.value)}
                      placeholder="sac"
                    />
                  </Field>
                  <Field
                    label="DES base path"
                    hint="Default: /api/v1/dataexport"
                    error={errors.desBasePath}
                  >
                    <input
                      className={inputClass}
                      value={values.desBasePath}
                      onChange={(e) => set("desBasePath", e.target.value)}
                      placeholder="/api/v1/dataexport"
                    />
                  </Field>
                </div>
              )}
            </>
          ) : (
            <>
              <Field label="Base URL" error={errors.baseUrl}>
                <input
                  className={inputClass}
                  value={values.baseUrl}
                  onChange={(e) => set("baseUrl", e.target.value)}
                />
              </Field>
              <Field label={editing ? "API key (leave blank to keep)" : "API key"} error={errors.secret}>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  value={values.secret}
                  onChange={(e) => set("secret", e.target.value)}
                />
              </Field>
            </>
          )}

          {testResult && (
            <div
              className={`rounded-lg px-3 py-2 text-xs ${
                testResult.ok
                  ? "bg-[var(--success)]/10 text-[var(--success)]"
                  : "bg-[var(--danger-bg)] text-[var(--danger)]"
              }`}
              role="status"
            >
              {testResult.message}
            </div>
          )}
        </div>

        <footer className="border-t border-[var(--border)] px-4 py-3 space-y-2">
          <button
            type="button"
            onClick={runTest}
            disabled={testing}
            className="w-full rounded-xl border border-accent/40 bg-accent/5 py-2 text-sm font-medium text-[var(--accent-text)] disabled:opacity-40"
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="w-full rounded-xl bg-accent py-2 text-sm font-medium text-[var(--on-accent)] hover:bg-accent-hover disabled:opacity-40"
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Save connection"}
          </button>
          {testResult?.ok && onBrowse && (
            <button type="button" onClick={onBrowse} className="w-full text-center text-xs font-medium text-[var(--accent-text)]">
              Browse models →
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
