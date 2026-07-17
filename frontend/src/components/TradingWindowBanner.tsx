"use client";

import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspaceStore";

export function TradingWindowBanner() {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const loaded = useWorkspaceStore((state) => state.loaded);
  const loadWorkspaces = useWorkspaceStore((state) => state.loadWorkspaces);
  const workspace = workspaces.find((item) => item.workspace_id === activeWorkspaceId);

  useEffect(() => {
    if (!loaded) void loadWorkspaces();
  }, [loaded, loadWorkspaces]);

  if (
    workspace?.sensitivity !== "upsi" ||
    workspace.trading_window_status !== "closed"
  ) {
    return null;
  }

  return (
    <div
      role="status"
      className="shrink-0 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-center text-xs font-medium text-red-700 dark:text-red-300"
    >
      Trading window closed
      {workspace.trading_window_until
        ? ` until ${new Date(workspace.trading_window_until).toLocaleDateString("en-IN")}`
        : ""}
      . This workspace contains UPSI; access is recorded in the Structured Digital Database.
      {workspace.trading_window_note ? ` ${workspace.trading_window_note}` : ""}
    </div>
  );
}
