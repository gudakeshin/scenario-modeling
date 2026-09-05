import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const simulationsRun = new client.Counter({
  name: "simulations_run_total",
  help: "Total number of scenario simulations executed",
  labelNames: ["engine"],
  registers: [registry],
});

export const monteCarloIterations = new client.Counter({
  name: "monte_carlo_iterations_total",
  help: "Total number of Monte Carlo iterations executed",
  registers: [registry],
});

export const llmTokensUsed = new client.Counter({
  name: "llm_tokens_used_total",
  help: "Total LLM tokens consumed",
  labelNames: ["model", "type"],
  registers: [registry],
});

export const xlsxRuntimeCacheEntries = new client.Gauge({
  name: "xlsx_runtime_cache_entries",
  help: "Current number of per-process HyperFormula runtimes cached",
  registers: [registry],
});

export const xlsxRuntimeCacheAccess = new client.Counter({
  name: "xlsx_runtime_cache_access_total",
  help: "HyperFormula runtime cache accesses",
  labelNames: ["result"],
  registers: [registry],
});

export const xlsxRuntimeProcessHeapBytes = new client.Gauge({
  name: "xlsx_runtime_process_heap_bytes",
  help: "Node.js heap used by the process hosting the HyperFormula runtime cache",
  registers: [registry],
});
