/**
 * Secret vault — AES-256-GCM encryption for planning-connector credentials.
 * Ciphertext format: v1:<iv_b64>:<tag_b64>:<ct_b64>
 * Key from CREDENTIALS_ENCRYPTION_KEY (64 hex chars = 32 bytes).
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_HEX_LEN = 64;
const VERSION_PREFIX = "v1";

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

function getKeyHex(): string | undefined {
  return process.env.CREDENTIALS_ENCRYPTION_KEY;
}

function parseKey(): Buffer {
  const hex = getKeyHex();
  if (!hex || hex.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new VaultError(
      "CREDENTIALS_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
    );
  }
  return Buffer.from(hex, "hex");
}

/** True when a usable encryption key is configured. */
export function isVaultConfigured(): boolean {
  const hex = getKeyHex();
  return !!hex && hex.length === KEY_HEX_LEN && /^[0-9a-fA-F]+$/.test(hex);
}

/**
 * Encrypt a UTF-8 secret. Returns `v1:<iv>:<tag>:<ciphertext>` (base64 parts).
 */
export function encryptSecret(plaintext: string): string {
  if (!isVaultConfigured()) {
    throw new VaultError("Credential vault is not configured");
  }
  const key = parseKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION_PREFIX,
    iv.toString("base64"),
    tag.toString("base64"),
    ct.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a `v1:` ciphertext blob. Throws on tamper / wrong key / bad format.
 */
export function decryptSecret(blob: string): string {
  if (!isVaultConfigured()) {
    throw new VaultError("Credential vault is not configured");
  }
  const parts = blob.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION_PREFIX) {
    throw new VaultError("Unrecognized ciphertext format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = Buffer.from(ivB64, "base64");
    tag = Buffer.from(tagB64, "base64");
    ct = Buffer.from(ctB64, "base64");
  } catch {
    throw new VaultError("Malformed ciphertext encoding");
  }
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new VaultError("Invalid ciphertext parameters");
  }
  const key = parseKey();
  try {
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new VaultError("Decryption failed — key mismatch or tampered ciphertext");
  }
}

/** Constant-time equality helper used by tests. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
