# Cross-Platform Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 cross-platform issues (4 critical, 5 moderate) that break or degrade cc2cc on Windows.

**Architecture:** All fixes are localized edits — no new files, no structural changes. The main theme is Windows file-locking (antivirus holds `.json` files briefly after creation, blocking `rename`/`replace`) and missing platform-specific handling.

**Tech Stack:** Node.js (server.mjs), Python (scripts/*, cc2cc/core.py)

---

### Task 1: Retry-wrapped rename in server.mjs (CRITICAL #3)

**Files:**
- Modify: `channel/server.mjs` — add `retryRename()` helper, replace all 4 `rename()` calls

- [ ] **Step 1:** Add `retryRename` helper after `atomicWrite` function (~line 88). Retries up to 5 times with 50ms backoff on `EPERM`/`EACCES` (Windows AV locking).
- [ ] **Step 2:** Replace all 4 `rename(` calls (lines 87, 592, 625, 736) with `retryRename(`.
- [ ] **Step 3:** Verify server starts and processes messages.

### Task 2: Graceful shutdown on Windows (CRITICAL #2)

**Files:**
- Modify: `channel/server.mjs` — add `process.on("exit", ...)` and `beforeExit`

- [ ] **Step 1:** Add `process.on("exit", ...)` for best-effort sync heartbeat write (covers Windows process kill).
- [ ] **Step 2:** Keep existing SIGINT/SIGTERM handlers (they work on Unix, SIGINT works on Windows Ctrl+C).

### Task 3: npm.cmd on Windows (CRITICAL #1)

**Files:**
- Modify: `scripts/init.py:52` — add `shell=True` on Windows

- [ ] **Step 1:** Use `shutil.which("npm")` to resolve actual npm path, fallback to `shell=True` on Windows.

### Task 4: os.rename → os.replace in cleanup.py (CRITICAL #4)

**Files:**
- Modify: `scripts/cleanup.py:48` — replace `os.rename` with `os.replace`

- [ ] **Step 1:** Change `os.rename` to `os.replace`.

### Task 5: encoding="utf-8" in cleanup.py (MODERATE #5)

**Files:**
- Modify: `scripts/cleanup.py:25,41` — add `encoding="utf-8"` to `open()` calls

### Task 6: File handle leak in validate.py (MODERATE #6)

**Files:**
- Modify: `scripts/validate.py:30` — use `with` statement or `Path.read_text()`

### Task 7: HOME undefined fallback in server.mjs (MODERATE #7)

**Files:**
- Modify: `channel/server.mjs:37` — add `os.homedir()` fallback

### Task 8: os.replace retry in core.py (MODERATE #8)

**Files:**
- Modify: `cc2cc/core.py:33` — add retry with backoff around `os.replace`

### Task 9: shutil.move retry in receive.py (MODERATE #9)

**Files:**
- Modify: `scripts/receive.py:60` — use `os.replace` with retry instead of `shutil.move`

### Task 10: Minor — UTF-8 encoding check in status.py

**Files:**
- Modify: `scripts/status.py:12` — check `not in ("utf-8", "utf8")` like init.py does

### Task 11: Commit and push
