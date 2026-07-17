import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { config } from "../config.js";

const MAGIC = Buffer.from("SME1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
export const DOCUMENT_ENCRYPTION_VERSION = "aes-256-gcm-hkdf-v1";

function masterKey(): Buffer | null {
  const hex = config.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

function deriveKey(documentId: string): Buffer {
  const master = masterKey();
  if (!master) throw new Error("Document encryption key is not configured");
  return Buffer.from(
    hkdfSync(
      "sha256",
      master,
      Buffer.from(documentId, "utf8"),
      Buffer.from("scenario-modeling/document-bytes/v1", "utf8"),
      32,
    ),
  );
}

export function isDocumentEncryptionConfigured(): boolean {
  return masterKey() !== null;
}

export function encryptDocumentBytes(
  documentId: string,
  plaintext: Buffer,
): { bytes: Buffer; version: string | null } {
  if (!isDocumentEncryptionConfigured()) return { bytes: plaintext, version: null };
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(documentId), iv);
  cipher.setAAD(Buffer.from(documentId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    bytes: Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]),
    version: DOCUMENT_ENCRYPTION_VERSION,
  };
}

export function decryptDocumentBytes(
  documentId: string,
  stored: Buffer,
  version?: string | null,
): Buffer {
  if (!version) return stored; // Backwards-compatible plaintext rows.
  if (version !== DOCUMENT_ENCRYPTION_VERSION || !stored.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`Unsupported document encryption format: ${version}`);
  }
  const iv = stored.subarray(4, 4 + IV_LENGTH);
  const tag = stored.subarray(4 + IV_LENGTH, 4 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = stored.subarray(4 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(documentId), iv);
  decipher.setAAD(Buffer.from(documentId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
