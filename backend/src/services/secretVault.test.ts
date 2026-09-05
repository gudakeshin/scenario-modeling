/**
 * Secret vault unit tests — round-trip, tamper detection, unconfigured throws.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

// Ensure vault key before importing module that reads config
process.env.CREDENTIALS_ENCRYPTION_KEY =
  process.env.CREDENTIALS_ENCRYPTION_KEY || randomBytes(32).toString("hex");

const { encryptSecret, decryptSecret, isVaultConfigured, VaultError } = await import(
  "./secretVault.js"
);

test("vault is configured when key is present", () => {
  assert.equal(isVaultConfigured(), true);
});

test("encrypt/decrypt round-trip", () => {
  const plain = "super-secret-client-secret-value";
  const blob = encryptSecret(plain);
  assert.ok(blob.startsWith("v1:"));
  assert.equal(decryptSecret(blob), plain);
});

test("GCM tamper detection", () => {
  const blob = encryptSecret("hello");
  const parts = blob.split(":");
  // Flip a bit in ciphertext
  const ct = Buffer.from(parts[3], "base64");
  ct[0] = ct[0] ^ 0xff;
  parts[3] = ct.toString("base64");
  assert.throws(() => decryptSecret(parts.join(":")), (e: Error) => e instanceof VaultError);
});

test("malformed blob throws", () => {
  assert.throws(() => decryptSecret("not-a-blob"), VaultError);
  assert.throws(() => decryptSecret("v2:a:b:c"), VaultError);
});

test("unconfigured vault rejects encryption and decryption", () => {
  const previous = process.env.CREDENTIALS_ENCRYPTION_KEY;
  delete process.env.CREDENTIALS_ENCRYPTION_KEY;
  try {
    assert.equal(isVaultConfigured(), false);
    assert.throws(() => encryptSecret("secret"), VaultError);
    assert.throws(() => decryptSecret("v1:a:b:c"), VaultError);
  } finally {
    process.env.CREDENTIALS_ENCRYPTION_KEY = previous;
  }
});
