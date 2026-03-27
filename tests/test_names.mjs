/**
 * Unit tests for channel/names.mjs
 *
 * Run with: node --test tests/test_names.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomName, validateName } from "../channel/names.mjs";

// ---------------------------------------------------------------------------
// randomName
// ---------------------------------------------------------------------------

test("randomName returns adjective-animal format", () => {
  const name = randomName();
  assert.match(
    name,
    /^[a-z]+-[a-z]+$/,
    `Expected adjective-animal format, got: ${name}`
  );
  const parts = name.split("-");
  assert.equal(parts.length, 2, "Name must have exactly two parts separated by -");
});

test("randomName generates varied names", () => {
  const SAMPLES = 50;
  const names = new Set();
  for (let i = 0; i < SAMPLES; i++) {
    names.add(randomName());
  }
  // With 20 adjectives × 20 animals = 400 combinations, we expect variety.
  // Probability of all 50 samples being identical is astronomically small.
  assert.ok(names.size > 1, `Expected varied names, but got ${names.size} unique in ${SAMPLES} samples`);
});

// ---------------------------------------------------------------------------
// validateName — valid cases
// ---------------------------------------------------------------------------

test("validateName accepts 'brave-fox'", () => {
  assert.equal(validateName("brave-fox"), true);
});

test("validateName accepts 'alpha'", () => {
  assert.equal(validateName("alpha"), true);
});

test("validateName accepts 'agent-01'", () => {
  assert.equal(validateName("agent-01"), true);
});

test("validateName accepts single character 'a'", () => {
  assert.equal(validateName("a"), true);
});

test("validateName accepts name starting with digit", () => {
  assert.equal(validateName("0abc"), true);
});

// ---------------------------------------------------------------------------
// validateName — invalid cases
// ---------------------------------------------------------------------------

test("validateName rejects empty string", () => {
  assert.equal(validateName(""), false);
});

test("validateName rejects name starting with dash", () => {
  assert.equal(validateName("-starts"), false);
});

test("validateName rejects name with uppercase letters", () => {
  assert.equal(validateName("Has-Uppercase"), false);
});

test("validateName rejects name with spaces", () => {
  assert.equal(validateName("has spaces"), false);
});

test("validateName rejects 32-character string", () => {
  // Max valid length is 31 (1 first char + 30 following chars)
  const tooLong = "a".repeat(32);
  assert.equal(validateName(tooLong), false);
});

test("validateName rejects non-string input", () => {
  assert.equal(validateName(null), false);
  assert.equal(validateName(undefined), false);
  assert.equal(validateName(42), false);
});
