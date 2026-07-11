# Contrast audit (theme tokens)

Manual check of CSS custom properties in `frontend/src/app/globals.css` for WCAG-ish contrast of primary UI text pairs. Not a full axe sweep — use this as a living checklist when tokens change.

## Light (`:root`)

| Foreground token | Background token | Intended use | Notes |
|------------------|------------------|--------------|--------|
| `--text-primary` (#1D1D1B) | `--background` (#FFFFFF) | Body text | High contrast |
| `--text-primary` | `--card-bg` (#FFFFFF) | Card body | High contrast |
| `--text-secondary` (#53565A) | `--background` | Secondary copy | Passes for normal text |
| `--text-muted` / `--text-tertiary` (#75787B) | `--background` | Meta labels | Borderline for small text; avoid for critical labels |
| `--text-faint` (#97999B) | `--background` | Hints only | Decorative / non-essential |
| `--message-user-text` (#FFFFFF) | `--message-user-bg` (#86BC25) | User bubbles | Accent green + white — verify at small sizes |
| `--sidebar-text` (#FFFFFF) | `--sidebar-bg` (#1D1D1B) | Nav | High contrast |
| `--sidebar-text-muted` (#97999B) | `--sidebar-bg` | Nav secondary | Acceptable for muted nav |
| `--danger` (#DA291C) | `--danger-bg` | Errors | Status on tinted bg |
| `--success` (#43B02A) | `--success-bg` | Success | Status on tinted bg |
| `--warning` (#DA8B00) | `--warning-bg` | Warnings | Status on tinted bg |
| `--info` (#0076A8) | `--info-bg` | Info | Status on tinted bg |

## Dark (`.dark`)

| Foreground token | Background token | Notes |
|------------------|------------------|--------|
| `--text-primary` / `--foreground` (#EDEDEC) | `--background` (#17181A) | High contrast |
| `--text-secondary` | `--card-bg` (#1E1F21) | Secondary copy |
| `--accent` (#9ED545) | `--background` | Links / CTAs — slightly brighter than light accent for dark surfaces |
| `--message-assistant-text` | `--message-assistant-bg` | Assistant bubbles |

## Chart / export

PNG export fills with computed `--card-bg` (or `--background`) so light/dark theme exports remain readable.

## Follow-ups

- Prefer `--text-secondary` over `--text-faint` for any actionable label.
- Re-run after token edits; optional: axe-core in frontend vitest for interactive panels.
