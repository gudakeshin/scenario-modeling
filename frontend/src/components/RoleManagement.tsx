"use client";

import { useEffect, useState, useCallback } from "react";
import { PanelHeader } from "./PanelHeader";
import { listUsers, updateUserRole, getRoles, type UserProfile, type RoleDescriptor } from "@/lib/api";

interface RoleManagementProps {
  onClose: () => void;
  onMinimize?: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  admin: "border-[var(--danger)]/20 bg-[var(--danger-bg)] text-[var(--danger)]",
  approver: "border-[var(--warning)]/20 bg-[var(--warning-bg)] text-[var(--warning)]",
  analyst: "border-accent/20 bg-accent/5 text-accent",
  viewer: "border-[var(--info)]/20 bg-[var(--info-bg)] text-[var(--info)]",
};

const FALLBACK_ROLES: RoleDescriptor[] = [
  { id: "viewer", label: "Viewer", description: "Can view scenarios and reports" },
  { id: "analyst", label: "Analyst", description: "Can create, edit, and share scenarios" },
  { id: "approver", label: "Approver", description: "Can approve scenarios for simulation" },
  { id: "admin", label: "Admin", description: "Full access including user management" },
];

export function RoleManagement({ onClose, onMinimize }: RoleManagementProps) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<RoleDescriptor[]>([]);

  useEffect(() => {
    getRoles()
      .then((r) => setRoles(r.length > 0 ? r : FALLBACK_ROLES))
      .catch(() => setRoles(FALLBACK_ROLES));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<string>("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listUsers();
      setUsers(data);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleRoleChange = async (userId: string) => {
    if (!pendingRole) return;
    try {
      await updateUserRole(userId, pendingRole);
      setEditingUser(null);
      setPendingRole("");
      await loadUsers();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="border border-[var(--panel-border)] rounded-2xl bg-[var(--card-bg)] p-4 mx-4 mb-3 overflow-auto max-h-[55vh] shadow-panel">
      <PanelHeader
        title="Role Management"
        icon={<div className="w-5 h-5 rounded-md bg-[var(--warning-bg)] flex items-center justify-center"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg></div>}
        onClose={onClose}
        onMinimize={onMinimize || onClose}
        isMinimized={false}
      />
      {/* Role legend */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {roles.map((role) => (
          <div key={role.id} className="rounded-xl border border-[var(--border-light)] bg-[var(--panel-bg)] p-2.5">
            <div className="flex items-center gap-1.5 mb-1">
              <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${ROLE_COLORS[role.id] || ""}`}>
                {role.label}
              </span>
            </div>
            <p className="text-[10px] text-[var(--text-faint)]">{role.description}</p>
          </div>
        ))}
      </div>

      {error && <p className="text-xs text-[var(--danger)] mb-2 bg-[var(--danger-bg)] px-3 py-1.5 rounded-lg">{error}</p>}

      {loading ? (
        <p className="text-xs text-[var(--text-faint)] text-center py-6">Loading users...</p>
      ) : (
        <div className="rounded-xl border border-[var(--card-border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--panel-bg)]">
                <th className="py-2.5 px-3 text-left font-medium text-[var(--text-secondary)]">User</th>
                <th className="py-2.5 px-3 text-left font-medium text-[var(--text-secondary)]">Department</th>
                <th className="py-2.5 px-3 text-center font-medium text-[var(--text-secondary)]">Role</th>
                <th className="py-2.5 px-3 text-right font-medium text-[var(--text-secondary)]">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.user_id} className="border-t border-[var(--border-light)] hover:bg-[var(--panel-bg)] transition-colors">
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center text-[10px] font-bold text-accent">
                        {(user.name || user.email)?.[0]?.toUpperCase() || "?"}
                      </div>
                      <div>
                        <p className="font-medium text-[var(--text-primary)]">{user.name || "\u2014"}</p>
                        <p className="text-[10px] text-[var(--text-faint)]">{user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-[var(--text-secondary)]">{user.department || "\u2014"}</td>
                  <td className="py-2.5 px-3 text-center">
                    {editingUser === user.user_id ? (
                      <select
                        value={pendingRole}
                        onChange={(e) => setPendingRole(e.target.value)}
                        className="rounded-lg border border-[var(--input-border)] bg-[var(--card-bg)] px-2 py-1 text-xs focus:outline-none focus:border-[var(--input-focus-border)]"
                      >
                        {roles.map((r) => (
                          <option key={r.id} value={r.id}>{r.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`inline-block text-[10px] px-2.5 py-0.5 rounded-full border font-medium ${ROLE_COLORS[user.role] || ROLE_COLORS.viewer}`}>
                        {user.role}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    {editingUser === user.user_id ? (
                      <div className="flex justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleRoleChange(user.user_id)}
                          className="text-[10px] px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent-hover transition-colors"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingUser(null); setPendingRole(""); }}
                          className="text-[10px] px-2.5 py-1 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)] transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingUser(user.user_id); setPendingRole(user.role); }}
                        className="text-[10px] px-2.5 py-1 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--panel-bg)] hover:shadow-card transition-all"
                      >
                        Edit role
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
