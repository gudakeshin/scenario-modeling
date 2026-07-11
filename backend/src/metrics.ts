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
