#!/usr/bin/env python3
"""
QA (adversarial) unit tests for the Python teams.json lock — cc2cc/admin.py
teams_lock() / with_teams_lock / _pid_alive.

Run: CC2CC_BRIDGE_DIR=<tmp> /opt/cc2cc/venv/bin/python3 tests/test_qa_lock_py.py
(the script makes its own tmp bridge if CC2CC_BRIDGE_DIR is unset).

No pytest. Plain asserts + a tiny runner. Exit code 0 = all pass.
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

# Make the repo importable regardless of cwd.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

PASS = []
FAIL = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"PASS  {name}")
    else:
        FAIL.append(name)
        print(f"FAIL  {name}  :: {detail}")


def fresh_bridge():
    d = tempfile.mkdtemp(prefix="cc2cc-qa-")
    os.environ["CC2CC_BRIDGE_DIR"] = d
    (Path(d) / "identities").mkdir(parents=True, exist_ok=True)
    return Path(d)


def reload_admin():
    """Import admin fresh so its module-level lock-path lambda picks up the env."""
    import importlib
    from cc2cc import admin as _admin
    importlib.reload(_admin)
    return _admin


# ─────────────────────────────────────────────────────────────────────────────
def test_lock_path_and_format():
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    with admin.teams_lock():
        # lock file exists while held
        assert lock.exists(), "lock file not created while held"
        holder = json.loads(lock.read_text())
        check("py.format.pid_int", isinstance(holder.get("pid"), int), holder)
        check("py.format.ts_ms_int", isinstance(holder.get("ts"), int) and holder["ts"] > 1_000_000_000_000,
              f"ts looks not-ms: {holder.get('ts')}")
        check("py.format.pid_is_ours", holder.get("pid") == os.getpid(), holder)
        check("py.path.sidecar", lock.name == "teams.json.lock", lock.name)
        # mode group-rw (best effort; on some FS chmod is masked but file should be 0660)
        mode = lock.stat().st_mode & 0o777
        check("py.mode.group_rw", mode & 0o060 == 0o060, oct(mode))
    check("py.release.unlinked", not lock.exists(), "lock not removed after release")


def test_release_on_exception():
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    raised = False
    try:
        with admin.teams_lock():
            assert lock.exists()
            raise ValueError("boom inside critical section")
    except ValueError:
        raised = True
    check("py.exc.propagates", raised, "exception swallowed")
    check("py.exc.lock_released", not lock.exists(), "lock left behind after exception -> DEADLOCK")
    # And we can re-acquire immediately (no deadlock).
    got = False
    with admin.teams_lock():
        got = True
    check("py.exc.reacquire", got, "could not re-acquire after exception")


def test_steal_dead_pid():
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    # Find a pid that is (almost certainly) dead. Spawn+reap a child.
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    dead_pid = p.pid
    p.wait()
    # write a FRESH-ts holder but with a DEAD pid -> must be stolen
    lock.write_text(json.dumps({"pid": dead_pid, "ts": int(time.time() * 1000)}))
    t0 = time.time()
    with admin.teams_lock():
        holder = json.loads(lock.read_text())
        check("py.steal.dead_pid_reclaimed", holder["pid"] == os.getpid(),
              f"did not steal dead-pid lock: {holder}")
    check("py.steal.dead_pid_fast", time.time() - t0 < 2.0, "stealing dead pid took too long")


def test_steal_old_ts_reused_pid():
    """A LIVE pid (e.g. reused) but an OLD ts must still be stolen (ts ages out the PID-reuse hole)."""
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    # Use our OWN pid (definitely alive) with a ts older than LOCK_MAX_HOLD_MS.
    old_ts = int(time.time() * 1000) - (admin._LOCK_MAX_HOLD_MS + 5000)
    lock.write_text(json.dumps({"pid": os.getpid(), "ts": old_ts}))
    t0 = time.time()
    with admin.teams_lock():
        holder = json.loads(lock.read_text())
        check("py.steal.old_ts_reclaimed", holder["ts"] > old_ts and holder["pid"] == os.getpid(),
              f"did not steal old-ts/live-pid lock: {holder}")
    check("py.steal.old_ts_fast", time.time() - t0 < 2.0, "stealing old-ts lock too slow")


def test_steal_torn_holder():
    """An unreadable / torn lock file is treated as stale and reclaimed."""
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    lock.write_text("{ this is not valid json")
    with admin.teams_lock():
        holder = json.loads(lock.read_text())
        check("py.steal.torn_reclaimed", holder["pid"] == os.getpid(), holder)


def test_no_steal_live_fresh():
    """A lock held by a LIVE holder with a FRESH ts must NOT be stolen — acquire must TIME OUT."""
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    # Live pid (our own), fresh ts.
    lock.write_text(json.dumps({"pid": os.getpid(), "ts": int(time.time() * 1000)}))
    t0 = time.time()
    threw = False
    try:
        with admin.teams_lock():
            pass
    except RuntimeError as e:
        threw = True
        msg = str(e)
    elapsed = time.time() - t0
    check("py.failloud.threw", threw, "did NOT fail loud — lock silently stolen from a live holder!")
    if threw:
        check("py.failloud.msg", "lock busy" in msg, msg)
    check("py.failloud.respected_timeout",
          admin._LOCK_ACQUIRE_TIMEOUT_S - 0.5 <= elapsed <= admin._LOCK_ACQUIRE_TIMEOUT_S + 3.0,
          f"elapsed={elapsed:.2f}s (timeout={admin._LOCK_ACQUIRE_TIMEOUT_S})")
    # The original holder file must be intact (not stolen / corrupted).
    holder = json.loads(lock.read_text())
    check("py.failloud.holder_intact", holder["pid"] == os.getpid(), holder)
    lock.unlink()


def test_failloud_no_partial_write():
    """When acquire times out inside a real mutating cmd, teams.json must be UNCHANGED."""
    bridge = fresh_bridge()
    admin = reload_admin()
    lock = bridge / "teams.json.lock"
    teams = bridge / "teams.json"
    # Seed a team owned by this machine so cmd_team_admit would otherwise mutate it.
    reg = {"teams": {"alpha": {"name": "alpha", "owner_machine": "local", "leader": "boss",
                              "succession": [], "rules": {}, "admitted": ["boss"], "revoked": []}}}
    teams.write_text(json.dumps(reg, indent=2))
    before = teams.read_text()
    # Hold the lock live+fresh so the decorated cmd cannot acquire.
    lock.write_text(json.dumps({"pid": os.getpid(), "ts": int(time.time() * 1000)}))

    class A:
        name = "alpha"
        agent = "newbie"
    threw = False
    try:
        admin.cmd_team_admit(A())
    except (RuntimeError, SystemExit) as e:
        threw = True
    check("py.failloud.cmd_threw", threw, "decorated cmd_team_admit did not error on lock timeout")
    after = teams.read_text()
    check("py.failloud.teams_unchanged", before == after,
          "teams.json was modified/partial-written despite lock timeout")
    # newbie must NOT have been admitted
    after_reg = json.loads(after)
    check("py.failloud.no_phantom_admit",
          "newbie" not in after_reg["teams"]["alpha"]["admitted"], after_reg)
    lock.unlink()


def test_concurrent_py_threads_no_lost_update():
    """Two Python writers (threads, distinct add) admitting to the SAME team — both must persist.
    Each goes through the real with_teams_lock decorator path via cmd_team_admit."""
    bridge = fresh_bridge()
    admin = reload_admin()
    teams = bridge / "teams.json"
    reg = {"teams": {"alpha": {"name": "alpha", "owner_machine": "local", "leader": "boss",
                              "succession": [], "rules": {}, "admitted": ["boss"], "revoked": []}}}
    teams.write_text(json.dumps(reg, indent=2))

    errors = []

    def admit(agent):
        class A:
            pass
        a = A(); a.name = "alpha"; a.agent = agent
        try:
            admin.cmd_team_admit(a)
        except SystemExit:
            pass
        except Exception as e:
            errors.append((agent, repr(e)))

    ts = [threading.Thread(target=admit, args=(f"u{i}",)) for i in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    check("py.concurrent.no_errors", not errors, errors)
    final = json.loads(teams.read_text())["teams"]["alpha"]["admitted"]
    expected = {"boss"} | {f"u{i}" for i in range(8)}
    check("py.concurrent.all_persisted", set(final) == expected,
          f"LOST UPDATE: expected {sorted(expected)} got {sorted(final)}")


def main():
    for fn in [
        test_lock_path_and_format,
        test_release_on_exception,
        test_steal_dead_pid,
        test_steal_old_ts_reused_pid,
        test_steal_torn_holder,
        test_no_steal_live_fresh,
        test_failloud_no_partial_write,
        test_concurrent_py_threads_no_lost_update,
    ]:
        print(f"\n=== {fn.__name__} ===")
        try:
            fn()
        except Exception as e:
            import traceback
            FAIL.append(fn.__name__)
            print(f"FAIL  {fn.__name__} (uncaught) :: {e}")
            traceback.print_exc()

    print(f"\n----- {len(PASS)} passed, {len(FAIL)} failed -----")
    if FAIL:
        print("FAILURES:", FAIL)
        sys.exit(1)


if __name__ == "__main__":
    main()
