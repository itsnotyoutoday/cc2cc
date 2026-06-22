#!/usr/bin/env bash
# Contention regression hammer for the teams.json write lock.
#
# Why this exists: the breakStaleLock TOCTOU (fixed in f1c2a41) and the re-stat false-positive only
# surface under CONCURRENT multi-writer load — a single test run passed ~75% of the time, so a normal
# one-shot CI run would let the regression escape. This runs the lock suite N times back-to-back and
# fails if ANY iteration fails OR if the re-stat guard's "lock no longer owned" false-positive or a
# "LOST UPDATE" ever appears. P(miss) for a 25%-per-run flake at N=20 is ~0.75^20 ≈ 0.3%; the nightly
# N=50 drives that to ~6e-7.
#
# Usage:   scripts/ci/hammer-lock.sh [iterations]
# Env:     PYTHON  — interpreter with fastapi/uvicorn + the cc2cc package importable (required in CI).
set -uo pipefail

ITERS="${1:-20}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# The three suites that exercise the lock under contention / the steal window / the re-stat guard.
SUITES=(
  tests/test_qa_lock_cross.mjs
  tests/test_qa_lock_contention.mjs
  tests/test_qa_lock_steal_window.mjs
  tests/test_qa_lock_restat.mjs
)

echo "== lock contention hammer: ${ITERS}x =="
echo "   PYTHON=${PYTHON:-<unset>}  node=$(node --version)"
fails=0
for i in $(seq 1 "$ITERS"); do
  out="$(node --test --test-force-exit "${SUITES[@]}" 2>&1)"
  if [ $? -ne 0 ] \
     || grep -qE "no longer owned|LOST UPDATE|SILENT CLOBBER" <<<"$out" \
     || grep -qE "^(✖|not ok)" <<<"$out"; then
    fails=$((fails + 1))
    echo "---- iteration $i FAILED ----"
    grep -E "✖|not ok|no longer owned|LOST UPDATE|SILENT CLOBBER|AssertionError" <<<"$out" | head -8
  fi
  if [ $((i % 10)) -eq 0 ]; then echo "   ...$i/$ITERS done (fails=$fails)"; fi
done

echo "== result: $((ITERS - fails))/${ITERS} clean, ${fails} failed =="
[ "$fails" -eq 0 ] || { echo "LOCK CONTENTION REGRESSION — see failed iterations above"; exit 1; }
echo "OK — no contention regression across ${ITERS} runs"
