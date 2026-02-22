"use client";

import { useState, useEffect, useRef } from "react";
import { getCurrentUser, switchMyRole, type UserProfile } from "@/lib/api";

const ROLES = [
  { id: "viewer", label: "Viewer", color: "bg-blue-500" },
  { id: "analyst", label: "Analyst", color: "bg-accent" },
  { id: "approver", label: "Approver", color: "bg-amber-500" },
  { id: "admin", label: "Admin", color: "bg-red-500" },
] as const;

export function RoleSwitcher() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCurrentUser().then(setUser).catch(() => {});
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSwitch = async (roleId: string) => {
    if (!user || roleId === user.role) { setOpen(false); return; }
    setSwitching(true);
    try {
      const updated = await switchMyRole(roleId);
      setUser(updated);
    } catch {
      // Silently fail — user stays on current role
    }
    setSwitching(false);
    setOpen(false);
  };

  if (!user) return null;

  const current = ROLES.find((r) => r.id === user.role) || ROLES[1];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={switching}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--card-bg)] hover:bg-[var(--panel-bg)] hover:border-[var(--panel-border)] transition-all text-xs font-medium text-[var(--text-secondary)] shadow-sm"
      >
        <span className={`w-2 h-2 rounded-full ${current.color}`} />
        <span>{user.name || user.email}</span>
        <span className="text-[var(--text-faint)]">|</span>
        <span className="font-semibold text-[var(--text-primary)]">{current.label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-52 rounded-xl border border-[var(--panel-border)] bg-[var(--card-bg)] shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-[var(--border-light)]">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">Switch Role</p>
          </div>
          {ROLES.map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => handleSwitch(role.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-xs text-left transition-colors ${
                role.id === user.role
                  ? "bg-accent/10 text-accent font-semibold"
                  : "text-[var(--text-secondary)] hover:bg-[var(--panel-bg)]"
              }`}
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${role.color}`} />
              <span className="flex-1">{role.label}</span>
              {role.id === user.role && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
