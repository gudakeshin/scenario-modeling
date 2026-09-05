import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  decryptDocumentBytes,
  DOCUMENT_ENCRYPTION_VERSION,
  encryptDocumentBytes,
} from "./documentCrypto.js";

test("document encryption: per-document AES-GCM round-trip and tamper detection", () => {
  const originalKey = config.CREDENTIALS_ENCRYPTION_KEY;
  config.CREDENTIALS_ENCRYPTION_KEY = "11".repeat(32);
  try {
    const documentId = randomUUID();
    const plaintext = Buffer.from("UPSI forecast workbook bytes");
    const encrypted = encryptDocumentBytes(documentId, plaintext);
    assert.equal(encrypted.version, DOCUMENT_ENCRYPTION_VERSION);
    assert.notDeepEqual(encrypted.bytes, plaintext);
    assert.deepEqual(
      decryptDocumentBytes(documentId, encrypted.bytes, encrypted.version),
      plaintext,
    );
    const tampered = Buffer.from(encrypted.bytes);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() =>
      decryptDocumentBytes(documentId, tampered, encrypted.version),
    );
    assert.throws(() =>
      decryptDocumentBytes(randomUUID(), encrypted.bytes, encrypted.version),
    );
  } finally {
    config.CREDENTIALS_ENCRYPTION_KEY = originalKey;
  }
});

test("document encryption: plaintext rows remain backwards compatible", () => {
  const plaintext = Buffer.from("legacy");
  assert.deepEqual(decryptDocumentBytes(randomUUID(), plaintext, null), plaintext);
});
