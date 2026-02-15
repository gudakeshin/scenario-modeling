import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        sidebar: {
          DEFAULT: "var(--sidebar-bg)",
          border: "var(--sidebar-border)",
          text: "var(--sidebar-text)",
          muted: "var(--sidebar-text-muted)",
          hover: "var(--sidebar-hover)",
          active: "var(--sidebar-active)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          hover: "var(--accent-hover)",
          light: "var(--accent-light)",
          muted: "var(--accent-muted)",
        },
        panel: {
          DEFAULT: "var(--panel-bg)",
          border: "var(--panel-border)",
        },
        card: {
          DEFAULT: "var(--card-bg)",
          border: "var(--card-border)",
        },
        border: {
          DEFAULT: "var(--border)",
          light: "var(--border-light)",
        },
        // Deloitte brand palette
        deloitte: {
          green: "#86BC25",
          "green-dark": "#6FA020",
          "green-alt": "#43B02A",
          black: "#1D1D1B",
          charcoal: "#2E2E2C",
          blue: "#0076A8",
          "blue-light": "#62B5E5",
          cyan: "#00A3E0",
          teal: "#007680",
          gray: {
            100: "#F7F7F5",
            200: "#E5E5E2",
            300: "#D0D0CE",
            400: "#BBBCBC",
            500: "#97999B",
            600: "#75787B",
            700: "#53565A",
          },
        },
        // Semantic status colors
        success: {
          DEFAULT: "var(--success)",
          bg: "var(--success-bg)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          bg: "var(--warning-bg)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          bg: "var(--danger-bg)",
        },
        info: {
          DEFAULT: "var(--info)",
          bg: "var(--info-bg)",
        },
      },
      borderRadius: {
        "4xl": "2rem",
      },
      boxShadow: {
        "panel": "0 1px 3px rgba(29, 29, 27, 0.06), 0 1px 2px rgba(29, 29, 27, 0.04)",
        "panel-lg": "0 4px 12px rgba(29, 29, 27, 0.08), 0 1px 3px rgba(29, 29, 27, 0.04)",
        "card": "0 1px 3px rgba(29, 29, 27, 0.04)",
        "card-hover": "0 4px 12px rgba(29, 29, 27, 0.08)",
      },
    },
  },
  plugins: [],
};
export default config;
