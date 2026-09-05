"use client";

import { useState, useEffect } from "react";
import { getCurrentUser, logout, type UserProfile } from "@/lib/api";

const ROLE_LABELS: Record<string, string> = {
  viewer: "Viewer",
  analyst: "Analyst",
  approver: "Approver",
  admin: "Admin",
};

const ROLE_COLORS: Record<string, string> = {
  viewer: "bg-blue-500",
  analyst: "bg-accent",
  approver: "bg-amber-500",
  admin: "bg-red-500",
};

/** Displays signed-in user + role. Role changes are admin-only (no self-promotion). */
export function RoleSwitcher() {
  const [user, setUser] = useState<UserProfile | null>(null);

  useEffect(() => {
    getCurrentUser().then(setUser).catch(() => setUser(null));
  }, []);

  if (!user) return null;

  const label = ROLE_LABELS[user.role] || user.role;
  const color = ROLE_COLORS[user.role] || "bg-accent";

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] text-xs font-medium text-[var(--text-secondary)] shadow-sm">
        <span className={`w-2 h-2 rounded-full ${color}`} />
        <span>{user.name || user.email}</span>
        <span className="text-[var(--text-faint)]">|</span>
        <span className="font-semibold text-[var(--text-primary)]">{label}</span>
      </div>
      <button
        type="button"
        onClick={async () => {
          await logout();
          window.location.href = "/login";
        }}
        className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:bg-[var(--panel-bg)]"
      >
        Sign out
      </button>
    </div>
  );
}
