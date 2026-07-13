"use client";

import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
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

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const emptyValues: ConnectionFormValues = {
  name: "",
  provider: "sap_sac",
  baseUrl: "https://",
  authKind: "oauth2_client_credentials",
  tokenUrl: "",
  clientId: "",
  secret: "",
  workspaceId: "",
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
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const describedBy = [
    error ? errorId : null,
    hint && !error ? hintId : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

  const control = Children.map(children, (child) => {
    if (!isValidElement(child)) return child;
    return cloneElement(child as ReactElement<Record<string, unknown>>, {
      id: inputId,
      "aria-invalid": error ? true : undefined,
      "aria-describedby": describedBy,
    });
  });

  return (
    <label className="block space-y-1" htmlFor={inputId}>
      <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
      {control}
      {hint && !error && (
        <span id={hintId} className="block text-[11px] text-[var(--text-muted)]">
          {hint}
        </span>
      )}
      {error && (
        <span id={errorId} role="alert" className="block text-[11px] text-[var(--danger)]">
          {error}
        </span>
      )}
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
  const providerLabelId = useId();
  const advancedPanelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

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
        workspaceId: String(pub.workspace_id ?? ""),
        namespaceId: String(pub.namespace_id ?? "sac"),
        desBasePath: String(pub.des_base_path ?? "/api/v1/dataexport"),
      });
      setAdvanced(
        connection.provider === "anaplan"
          ? connection.auth_kind === "api_key"
          : Boolean(pub.namespace_id || pub.des_base_path),
      );
    }
    setErrors({});
    setTestResult(null);
  }, [open, connection]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);

      if (focusables.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !panelRef.current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const set = (field: keyof ConnectionFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
    setTestResult(null);
  };

  const changeProvider = (provider: ProviderId) => {
    if (editing) return;
    setValues((current) => {
      if (provider === "sap_sac") {
        return {
          ...current,
          provider,
          baseUrl: "https://",
          authKind: "oauth2_client_credentials",
          namespaceId: "sac",
          desBasePath: "/api/v1/dataexport",
        };
      }
      if (provider === "anaplan") {
        return {
          ...current,
          provider,
          baseUrl: "https://api.anaplan.com/2/0",
          authKind: "oauth2_client_credentials",
          tokenUrl: "https://auth.anaplan.com/token/authenticate",
          clientId: "",
          secret: "",
          namespaceId: "",
          desBasePath: "",
        };
      }
      return {
        ...current,
        provider,
        baseUrl: "mock://local",
        authKind: "api_key",
        tokenUrl: "",
        clientId: "",
        namespaceId: "",
        desBasePath: "",
      };
    });
    setAdvanced(false);
    setErrors({});
    setTestResult(null);
  };

  const toggleAnaplanAuth = (useToken: boolean) => {
    setValues((current) => ({
      ...current,
      authKind: useToken ? "api_key" : "oauth2_client_credentials",
      secret: "",
      ...(useToken
        ? {}
        : { tokenUrl: current.tokenUrl || "https://auth.anaplan.com/token/authenticate" }),
    }));
    setAdvanced(useToken);
    setErrors({});
    setTestResult(null);
  };

  const buildAuthPublic = (): Record<string, unknown> => {
    if (values.provider === "anaplan") {
      return {
        workspace_id: values.workspaceId.trim(),
        ...(values.authKind === "oauth2_client_credentials"
          ? {
              token_url: values.tokenUrl.trim(),
              client_id: values.clientId.trim(),
            }
          : {}),
      };
    }
    if (values.provider === "sap_sac" && values.authKind === "oauth2_client_credentials") {
      return {
        token_url: values.tokenUrl.trim(),
        client_id: values.clientId.trim(),
        namespace_id: values.namespaceId.trim() || "sac",
        des_base_path: values.desBasePath.trim() || "/api/v1/dataexport",
      };
    }
    return {};
  };

  const draftBody = () => ({
    provider: values.provider,
    base_url: values.baseUrl.trim(),
    auth_kind: values.authKind,
    auth_public: buildAuthPublic(),
    secret: values.secret,
  });

  const runTest = async () => {
    const nextErrors = validateConnection(values, { editing: editing && !values.secret.trim() });
    if (editing && !values.secret.trim()) {
      const credentialName = values.provider === "anaplan"
        ? values.authKind === "api_key"
          ? "auth token"
          : "password"
        : "client secret";
      setTestResult({
        ok: false,
        message: `Enter the ${credentialName} to test before saving, or save first and use Test on the card.`,
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
    } catch (error) {
      const message = (error as Error).message;
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
    } catch (error) {
      toast.error((error as Error).message);
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
        tabIndex={-1}
        className="relative z-10 flex h-full w-full max-w-md flex-col border-l border-[var(--border)] bg-[var(--card-bg)] shadow-2xl outline-none"
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
              onChange={(event) => set("name", event.target.value)}
              placeholder="e.g. SAP-Prod"
            />
          </Field>

          <div>
            <p id={providerLabelId} className="mb-2 text-xs font-medium text-[var(--text-primary)]">
              Provider
            </p>
            <ProviderPicker
              value={values.provider}
              onChange={changeProvider}
              disabled={editing}
              aria-labelledby={providerLabelId}
            />
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
                  onChange={(event) => set("baseUrl", event.target.value)}
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
                  onChange={(event) => set("tokenUrl", event.target.value)}
                  placeholder="https://…/oauth/token"
                />
              </Field>
              <Field label="Client ID" hint="Where to find: OAuth client app registration" error={errors.clientId}>
                <input
                  className={inputClass}
                  value={values.clientId}
                  onChange={(event) => set("clientId", event.target.value)}
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
                  onChange={(event) => set("secret", event.target.value)}
                />
              </Field>

              <button
                type="button"
                aria-expanded={advanced}
                aria-controls={advancedPanelId}
                onClick={() => setAdvanced((value) => !value)}
                className="text-xs font-medium text-[var(--accent-text)]"
              >
                {advanced ? "Hide advanced" : "Advanced (namespace & DES path)"}
              </button>
              {advanced && (
                <div
                  id={advancedPanelId}
                  className="space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel-bg)] p-3"
                >
                  <Field
                    label="Namespace ID"
                    hint="Default: sac — override for non-default tenants"
                  >
                    <input
                      className={inputClass}
                      value={values.namespaceId}
                      onChange={(event) => set("namespaceId", event.target.value)}
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
                      onChange={(event) => set("desBasePath", event.target.value)}
                      placeholder="/api/v1/dataexport"
                    />
                  </Field>
                </div>
              )}
            </>
          ) : values.provider === "anaplan" ? (
            <>
              <Field
                label="Base URL"
                hint="Anaplan Cell Data API base URL (HTTPS, or mock://local for local testing)"
                error={errors.baseUrl}
              >
                <input
                  className={inputClass}
                  value={values.baseUrl}
                  onChange={(event) => set("baseUrl", event.target.value)}
                  placeholder="https://api.anaplan.com/2/0"
                />
              </Field>
              <Field
                label="Workspace ID"
                hint="From the Anaplan URL or Administration → Workspaces"
                error={errors.workspaceId}
              >
                <input
                  className={inputClass}
                  value={values.workspaceId}
                  onChange={(event) => set("workspaceId", event.target.value)}
                />
              </Field>

              <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-primary)]">
                <input
                  type="checkbox"
                  checked={values.authKind === "api_key"}
                  onChange={(event) => toggleAnaplanAuth(event.target.checked)}
                />
                Use a pre-issued auth token
              </label>

              {values.authKind === "oauth2_client_credentials" ? (
                <>
                  <Field
                    label="Token URL"
                    hint="Anaplan authentication endpoint"
                    error={errors.tokenUrl}
                  >
                    <input
                      className={inputClass}
                      value={values.tokenUrl}
                      onChange={(event) => set("tokenUrl", event.target.value)}
                      placeholder="https://auth.anaplan.com/token/authenticate"
                    />
                  </Field>
                  <Field label="Username" hint="Your Anaplan sign-in username" error={errors.clientId}>
                    <input
                      className={inputClass}
                      value={values.clientId}
                      onChange={(event) => set("clientId", event.target.value)}
                      autoComplete="username"
                    />
                  </Field>
                  <Field
                    label={editing ? "Password (leave blank to keep)" : "Password"}
                    hint="Write-only — never shown again after save"
                    error={errors.secret}
                  >
                    <input
                      type="password"
                      autoComplete="new-password"
                      className={inputClass}
                      value={values.secret}
                      onChange={(event) => set("secret", event.target.value)}
                    />
                  </Field>
                </>
              ) : (
                <Field
                  label={editing ? "AnaplanAuthToken value (leave blank to keep)" : "AnaplanAuthToken value"}
                  hint="Pre-issued tokens have a ~35-minute expiry"
                  error={errors.secret}
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={inputClass}
                    value={values.secret}
                    onChange={(event) => set("secret", event.target.value)}
                  />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Base URL" error={errors.baseUrl}>
                <input
                  className={inputClass}
                  value={values.baseUrl}
                  onChange={(event) => set("baseUrl", event.target.value)}
                />
              </Field>
              <Field label={editing ? "API key (leave blank to keep)" : "API key"} error={errors.secret}>
                <input
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  value={values.secret}
                  onChange={(event) => set("secret", event.target.value)}
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
            <button
              type="button"
              onClick={onBrowse}
              className="w-full text-center text-xs font-medium text-[var(--accent-text)]"
            >
              Browse models →
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
