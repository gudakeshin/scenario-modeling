"use client";

import { FormEvent, useMemo, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login, register, isAuthenticated } from "@/lib/api";

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = useMemo(() => {
    const n = searchParams.get("next");
    return n && n.startsWith("/") ? n : "/";
  }, [searchParams]);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated()) router.replace(nextPath);
  }, [router, nextPath]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, name.trim() || undefined);
      }
      router.replace(nextPath);
    } catch (err) {
      setError((err as Error).message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[var(--bg)] px-4">
      <div className="w-full max-w-md border border-[var(--border)] bg-[var(--card-bg)] rounded-2xl p-8 shadow-sm">
        <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-faint)] mb-2">
          Scenario Modeling
        </p>
        <h1 className="text-2xl font-semibold text-[var(--text-primary)] mb-1">
          {mode === "login" ? "Sign in" : "Create account"}
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-6">
          {mode === "login"
            ? "Use your local account credentials."
            : "First registered user becomes admin. Later accounts require an admin."}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          {mode === "register" && (
            <label className="block text-sm">
              <span className="text-[var(--text-secondary)]">Name</span>
              <input
                className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-[var(--text-primary)]"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
            </label>
          )}
          <label className="block text-sm">
            <span className="text-[var(--text-secondary)]">Email</span>
            <input
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-[var(--text-primary)]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </label>
          <label className="block text-sm">
            <span className="text-[var(--text-secondary)]">Password</span>
            <input
              type="password"
              required
              minLength={8}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-[var(--text-primary)]"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>

          {error && (
            <p className="text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-accent text-white py-2.5 text-sm font-semibold disabled:opacity-60"
          >
            {loading ? "Please wait…" : mode === "login" ? "Sign in" : "Register"}
          </button>
        </form>

        <button
          type="button"
          className="mt-4 text-sm text-accent underline"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "Need an account? Register" : "Already have an account? Sign in"}
        </button>
      </div>
    </main>
  );
}
