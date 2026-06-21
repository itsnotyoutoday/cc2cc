/**
 * M4: relay dedup survives a daemon restart. A processed message id is persisted to
 * seen-messages.json; after a restart (in-memory set lost, then reloaded) the id is still
 * "seen", so a re-leased/redelivered message is NOT processed twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  hasSeenMessage, isSeen, persistSeenMessages, loadSeenMessages, clearSeenMessages, seenCount,
} from "../channel/relay.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("M4: dedup state survives a simulated restart (persist → clear → load)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc2cc-dedup-"));
  try {
    clearSeenMessages(); // clean slate (module-level set)
    const id = "relay-abc-123";

    assert.equal(isSeen(id), false, "unseen before processing");
    assert.equal(hasSeenMessage(id), false, "first sighting → false, and marks it seen");
    assert.equal(isSeen(id), true, "now seen in-memory");
    assert.equal(hasSeenMessage(id), true, "second sighting → true (dedup hit, same run)");

    // Flush to disk (fire-and-forget) — poll until seen-messages.json carries the id.
    persistSeenMessages(dir);
    const seenFile = join(dir, "seen-messages.json");
    let persisted = false;
    for (let i = 0; i < 20; i++) {
      try { if (JSON.parse(await readFile(seenFile, "utf8")).includes(id)) { persisted = true; break; } } catch {}
      await sleep(50);
    }
    assert.ok(persisted, "id persisted to seen-messages.json");

    // Simulate a daemon restart: in-memory dedup is gone.
    clearSeenMessages();
    assert.equal(isSeen(id), false, "after restart the in-memory set is empty");
    assert.equal(seenCount(), 0);

    // Reload from disk → dedup restored.
    await loadSeenMessages(dir);
    assert.equal(isSeen(id), true, "id restored from disk → a redelivery would be deduped");
    assert.ok(seenCount() >= 1, "restored set is non-empty");
  } finally {
    clearSeenMessages();
    rmSync(dir, { recursive: true, force: true });
  }
});
