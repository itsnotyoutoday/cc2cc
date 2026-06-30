/**
 * #4 + m2: encryption boundary, exercised through server.mjs's EXPORTED decryptMessage
 * (crypto.mjs was removed; server.mjs owns crypto now). The key is supplied directly via
 * setEncryptionKey, so these assert the AES-256-GCM + ENC:-envelope + fail-closed BEHAVIOR
 * without coupling to the m2 KDF (salt/cost) internals.
 *
 * Covers: round-trip, wrong-key reject, tampered-tag reject, strip-defense (a RELAYED
 * non-ENC: payload is quarantined), and local (non-relayed) plaintext passthrough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";

// ENCRYPT_ENABLED is read from env at module load → set it BEFORE importing server.mjs.
process.env.CC2CC_ENCRYPT = "1";
const { decryptMessage, setEncryptionKey } = await import("../channel/server.mjs");

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

// Mirror server.mjs's ENC: envelope: ENC:<iv-hex>:<tag-hex>:<ciphertext-hex>, AES-256-GCM, 12-byte IV.
function seal(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return `ENC:${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${enc.toString("hex")}`;
}
const relayed = (text) => ({ id: "m", from: "x", _relay_meta: { from_machine: "peer", from_team: "o", to_team: "t" }, content: { text } });
const local = (text) => ({ id: "m", from: "x", content: { text } }); // no _relay_meta

test("round-trip: a message sealed with the active key decrypts to plaintext", () => {
  setEncryptionKey(KEY);
  const m = decryptMessage(relayed(seal(KEY, "secret-hello-123")));
  assert.ok(m, "not quarantined");
  assert.equal(m.content.text, "secret-hello-123");
});

test("wrong key: ciphertext for a different key is quarantined (null), never surfaced", () => {
  setEncryptionKey(OTHER_KEY);
  assert.equal(decryptMessage(relayed(seal(KEY, "secret-hello-123"))), null);
});

test("tampered tag: a flipped ciphertext byte fails the GCM tag → quarantined", () => {
  setEncryptionKey(KEY);
  const env = seal(KEY, "tamper-me");
  // Flip the last hex nibble of the ciphertext segment.
  const last = env.slice(-1);
  const tampered = env.slice(0, -1) + (last === "0" ? "1" : "0");
  assert.equal(decryptMessage(relayed(tampered)), null);
});

test("strip-defense: a RELAYED non-ENC: payload is quarantined when encryption is on", () => {
  setEncryptionKey(KEY);
  assert.equal(decryptMessage(relayed("INJECTED-PLAINTEXT")), null,
    "a relayed message that arrives unencrypted must not surface as plaintext");
});

test("local passthrough: a non-relayed (local) plaintext message is delivered as-is", () => {
  setEncryptionKey(KEY);
  const m = decryptMessage(local("local hi"));
  assert.ok(m, "local plaintext is allowed (encryption boundary is the relay/wire)");
  assert.equal(m.content.text, "local hi");
});
