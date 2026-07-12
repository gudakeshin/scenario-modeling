"use client";

import { useEffect, useState } from "react";
import { getTheme, toggleTheme, type Theme } from "@/lib/theme";

type ChromeVariant = "sidebar" | "page";

export function ThemeToggle({
  className = "",
  variant = "sidebar",
}: {
  className?: string;
  variant?: ChromeVariant;
}) {
  const [theme, setThemeState] = useState<Theme>("light");

  useEffect(() => {
    setThemeState(getTheme());
  }, []);

  const chromeClass =
    variant === "page"
      ? "hover:bg-[var(--panel-bg)] text-[var(--text-secondary)]"
      : "hover:bg-[var(--sidebar-hover)] text-[var(--sidebar-text-muted)]";

  return (
    <button
      type="button"
      onClick={() => setThemeState(toggleTheme())}
      className={`p-1.5 rounded-lg transition-colors ${chromeClass} ${className}`}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
