"use client";

import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export interface ConfirmOptions {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

/**
 * Promise-based replacement for `window.confirm`, rendered with the app's own
 * ConfirmDialog so it is themeable, focus-managed and non-blocking.
 *
 *   const { confirm, confirmDialog } = useConfirm();
 *   if (!(await confirm({ title: "Delete?", description: "…", danger: true }))) return;
 *   …
 *   return <>{…}{confirmDialog}</>;
 */
export function useConfirm() {
  const [request, setRequest] = useState<PendingRequest | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  const settle = useCallback(
    (ok: boolean) => {
      request?.resolve(ok);
      setRequest(null);
    },
    [request],
  );

  const confirmDialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ""}
      description={request?.description ?? ""}
      confirmLabel={request?.confirmLabel}
      cancelLabel={request?.cancelLabel}
      danger={request?.danger}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}
