import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// vitest runs without `globals`, so React Testing Library cannot register its
// own auto-cleanup. Without this, renders leak between tests in a file and
// queries start matching duplicates.
afterEach(cleanup);

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
