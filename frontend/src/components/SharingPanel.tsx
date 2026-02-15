"use client";

import { useEffect, useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { listUsers, shareScenario, getShares, revokeShare, type UserProfile, type SharingRecord } from "@/lib/api";

interface SharingPanelProps {
  scenarioId: string;
  onClose: () => void;
  onMinimize?: () => void;
}

export function SharingPanel({ scenarioId, onClose, onMinimize }: SharingPanelProps) {
  const [shares, setShares] = useState<SharingRecord[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [shareData, userData] = await Promise.all([
        getShares(scenarioId),
        listUsers(),
      ]);
      setShares(shareData);
      setUsers(userData);
    } catch {
      // Shares or users fetch failed — partial is ok
      try { setShares(await getShares(scenarioId)); } catch { /* empty */ }
      try { setUsers(await listUsers()); } catch { /* empty */ }
    }
  }, [scenarioId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleShare = async () => {
    if (!selectedUserId) return;
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      await shareScenario(scenarioId, selectedUserId, permission);
      setSuccess("Scenario shared successfully");
      setSelectedUserId("");
      await loadData();
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };

  const handleRevoke = async (sharingId: string) => {
    try {
      await revokeShare(sharingId);
      await loadData();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // Filter out users who already have access
  const sharedUserIds = new Set(shares.map((s) => s.shared_with));
  const availableUsers = users.filter((u) => !sharedUserIds.has(u.user_id));

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 overflow-auto max-h-[55vh] shadow-panel">
      <PanelHeader
        title="Share Scenario"
        icon={<div className="w-5 h-5 rounded-md bg-[var(--info-bg)] flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--info)" strokeWidth="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {/* Share form */}
      <div className="flex items-center gap-2 mb-4 bg-[var(--panel-bg)] rounded-xl border border-[var(--panel-border)] p-3">
        <select
          value={selectedUserId}
          onChange={(e) => setSelectedUserId(e.target.value)}
          className="flex-1 rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--input-focus-border)] focus:ring-1 focus:ring-accent/20"
        >
          <option value="">Select a user...</option>
          {availableUsers.map((u) => (
            <option key={u.user_id} value={u.user_id}>
              {u.name || u.email} ({u.role})
            </option>
          ))}
        </select>
        <select
          value={permission}
          onChange={(e) => setPermission(e.target.value as "view" | "edit")}
          className="rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--input-focus-border)]"
        >
          <option value="view">Can view</option>
          <option value="edit">Can edit</option>
        </select>
        <button
          type="button"
          onClick={handleShare}
          disabled={loading || !selectedUserId}
          className="rounded-lg bg-accent px-4 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40 shadow-sm transition-colors"
        >
          {loading ? "..." : "Share"}
        </button>
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}
      {success && <p className="text-xs text-[var(--success)] mb-2 bg-[var(--success-bg)] px-3 py-1.5 rounded-lg">{success}</p>}

      {/* Current shares */}
      {shares.length > 0 ? (
        <div>
          <h4 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Shared with</h4>
          <div className="space-y-1.5">
            {shares.map((share) => (
              <div
                key={share.sharing_id}
                className="flex items-center justify-between px-3 py-2 rounded-xl border border-[var(--border-light)] bg-[var(--panel-bg)] hover:shadow-card transition-shadow"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center text-[10px] font-bold text-accent">
                    {(share.name || share.email)?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-[var(--text-primary)]">{share.name || "Unknown"}</p>
                    <p className="text-[10px] text-[var(--text-faint)]">{share.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    share.permission === "edit"
                      ? "border-[var(--warning)]/20 bg-[var(--warning-bg)] text-[var(--warning)]"
                      : "border-[var(--info)]/20 bg-[var(--info-bg)] text-[var(--info)]"
                  }`}>
                    {share.permission}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRevoke(share.sharing_id)}
                    className="text-[10px] text-[var(--danger)] hover:text-[var(--danger)]/80 transition-colors"
                    title="Revoke access"
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-xs text-[var(--text-faint)] text-center py-4">
          This scenario hasn&apos;t been shared with anyone yet.
        </p>
      )}
    </div>
  );
}
