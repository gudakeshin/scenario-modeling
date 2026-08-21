import test from "node:test";
import assert from "node:assert";
import { questionSlug, normalizeFollowUpQuestions } from "./followUpQuestions.js";

test("an unnamed question gets a stable id derived from its text", () => {
  const question = "What magnitude of raw material cost increase should we model?";
  assert.strictEqual(questionSlug(question), questionSlug(question), "deterministic");
  assert.match(questionSlug(question), /^q_/);
  // Readable, so the audit trail says what was asked.
  assert.match(questionSlug(question), /magnitude/);
  assert.notStrictEqual(questionSlug(question), questionSlug("A different question entirely"));
});

test("the same question asked twice collapses to one entry", () => {
  const raw = [
    { question: "Should volume stay constant?", options: [] },
    { question: "Should volume stay constant?", options: [] },
  ];
  const normalized = normalizeFollowUpQuestions(raw);
  assert.strictEqual(
    normalized.length,
    1,
    "a repeated question is the same question, not a second one",
  );
});

test("an explicit id from the model is preserved", () => {
  const normalized = normalizeFollowUpQuestions([
    { id: "pricing_response", question: "Hold NSP or pass through?", options: [] },
  ]);
  assert.strictEqual(normalized[0].id, "pricing_response");
});
