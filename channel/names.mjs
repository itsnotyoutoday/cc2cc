/**
 * CC2CC Name Generation Module
 *
 * Provides random agent name generation and validation utilities.
 * Names follow the "adjective-animal" format from predefined dictionaries.
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";

const ADJECTIVES = [
  "brave", "calm", "swift", "bold", "keen",
  "wise", "fair", "warm", "wild", "cool",
  "bright", "quick", "sharp", "proud", "free",
  "true", "kind", "pure", "deep", "clear",
];

const ANIMALS = [
  "fox", "owl", "bear", "wolf", "hawk",
  "deer", "lynx", "crow", "hare", "seal",
  "dove", "swan", "toad", "moth", "wren",
  "lark", "bass", "crab", "newt", "wasp",
];

const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Returns a random element from an array. */
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Returns a random "adjective-animal" name string.
 * @returns {string}
 */
export function randomName() {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
}

/**
 * Validates a name against the allowed pattern.
 * Pattern: starts with [a-z0-9], followed by up to 30 chars of [a-z0-9-].
 * Total max length: 31 characters.
 * @param {string} name
 * @returns {boolean}
 */
export function validateName(name) {
  return typeof name === "string" && NAME_REGEX.test(name);
}

/**
 * Reads the bridge directory's status/ heartbeats and returns a Set of
 * active agent names. An agent is considered active if its heartbeat is
 * less than 30 seconds old and its status field equals "active".
 * @param {string} bridgeDir — path to bridge root
 * @returns {Promise<Set<string>>}
 */
export async function takenNames(bridgeDir) {
  const statusDir = join(bridgeDir, "status");
  const taken = new Set();
  const now = Date.now();
  const MAX_AGE_MS = 30_000;

  let files;
  try {
    files = await readdir(statusDir);
  } catch {
    // If status dir doesn't exist, no names are taken
    return taken;
  }

  await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith(".json")) return;
      try {
        const raw = await readFile(join(statusDir, file), "utf8");
        const data = JSON.parse(raw);
        const { name, status, heartbeat } = data;
        if (!name || status !== "active") return;
        const age = now - new Date(heartbeat).getTime();
        if (age < MAX_AGE_MS) {
          taken.add(name);
        }
      } catch {
        // Ignore unreadable or malformed heartbeat files
      }
    })
  );

  return taken;
}

/**
 * Generates a unique agent name not present in the current taken set.
 * Retries up to 10 times; on failure appends a random 4-char hex suffix.
 * @param {string} bridgeDir — path to bridge root
 * @returns {Promise<string>}
 */
export async function generateUniqueName(bridgeDir) {
  const taken = await takenNames(bridgeDir);
  const MAX_RETRIES = 10;

  for (let i = 0; i < MAX_RETRIES; i++) {
    const candidate = randomName();
    if (!taken.has(candidate)) {
      return candidate;
    }
  }

  // Fallback: append a random 4-char hex suffix
  const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${randomName()}-${suffix}`;
}
