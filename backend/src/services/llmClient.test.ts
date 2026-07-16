import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { modelSupportsSamplingParams } from "./llmClient.js";

describe("modelSupportsSamplingParams", () => {
  it("keeps temperature for Haiku 4.5 and Sonnet 4.5", () => {
    assert.equal(modelSupportsSamplingParams("claude-haiku-4-5-20251001"), true);
    assert.equal(modelSupportsSamplingParams("claude-sonnet-4-5-20250929"), true);
    assert.equal(modelSupportsSamplingParams("claude-sonnet-4-20250514"), true);
    assert.equal(modelSupportsSamplingParams("claude-opus-4-6"), true);
  });

  it("omits temperature for Opus 4.7+, Opus 4.8, and Sonnet 5", () => {
    assert.equal(modelSupportsSamplingParams("claude-opus-4-7"), false);
    assert.equal(modelSupportsSamplingParams("claude-opus-4-8"), false);
    assert.equal(modelSupportsSamplingParams("claude-sonnet-5"), false);
    assert.equal(modelSupportsSamplingParams("claude-sonnet-5-20260301"), false);
  });
});
