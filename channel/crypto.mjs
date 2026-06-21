/**
 * AES-256-GCM crypto for cc2cc — owned by the DAEMON (channel/daemon.mjs), the endpoint that
 * talks to the hub. The daemon is the encryption boundary: it ENCRYPTS outbound before relaying
 * and DECRYPTS inbound before writing plaintext into the local inbox. Therefore:
 *   - the HUB never holds the key (zero-knowledge — it only sees `ENC:` ciphertext);
 *   - the MCP needs NO crypto (it reads/writes plaintext local inboxes).
 * Key derived from the bridge's secret.key via scrypt. GCM → tamper-evident.
 */
import { readFile } from "fs/promises";
import { join } from "path";
import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "crypto";

let key = null;

export function setKey(k) { key = k; }       // test hook
export function hasKey() { return !!key; }

/** Load + derive the key from <bridgeDir>/secret.key. Returns the key (or null on miss). */
export async function loadKey(bridgeDir) {
  try {
    const secret = (await readFile(join(bridgeDir, "secret.key"), "utf8")).trim();
    key = scryptSync(secret, "cc2cc-aes", 32);
  } catch {
    key = null;
  }
  return key;
}

export function encryptText(plaintext) {
  if (!key) return plaintext;
  const iv = randomBytes(12); // m1: full 96-bit random nonce (was a truncated UUID)
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `ENC:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptText(data) {
  if (!key || typeof data !== "string" || !data.startsWith("ENC:")) return data;
  const [, ivHex, tagHex, encHex] = data.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(encHex, "hex"), null, "utf8") + decipher.final("utf8");
}
