import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Avoid @vitejs/plugin-react — Vite major mismatch with Vitest's bundled Vite.
  // esbuild JSX transform is enough for component tests.
  esbuild: {
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
