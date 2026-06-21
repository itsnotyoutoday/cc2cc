#!/usr/bin/env python3
"""cc2cc-admin — operator/administration CLI for cc2cc (separate from the agent MCP runtime).

The MCP server (channel/server.mjs) is the AGENT runtime (send/receive/whoami). Boundary:
  * Day-to-day team membership (a LEADER admitting/evicting members of ITS OWN team) is a
    runtime action and is exposed via MCP tools to leaders.
  * HIGHER GOVERNANCE — provisioning members, creating teams, defining rules (retention /
    expiration / admission), designating/overriding leaders, succession, inspecting the
    federated directory — is an OPERATOR function and lives here in cc2cc-admin.
  * In the end, the GAB's federated team POLICY governs: every actor (even a leader's
    admit/evict) operates within the team's published rules.
This tool can also perform admit/revoke (operator authority), but the runtime MCP path is the
leader's everyday tool.

Federation model (see TESTING/ARCHITECTURE-FEDERATION.md):
  * A MACHINE (this bridge) is authoritative for the MEMBERS it hosts (identity-<name>.json).
  * A TEAM's rules are administered by the team's owner machine (team-<name>.json).
  * Membership is a handshake: the home machine vouches the member's identity; the team owner
    admits it per team rules. "Revoke" removes a member's PARTICIPATION (tombstone) — it does
    not delete the member's identity (that is the home machine's authority).

All commands act on the LOCAL bridge (CC2CC_BRIDGE_DIR or ~/.cc2cc) — i.e. this machine's own
authority. They never reach into another machine's authority.

Bridge artifacts this tool owns:
  identity-<name>.json   {display_name, agent_id, created, last_seen, teams[]}  (NO role)
  team-<name>.json       {name, owner_machine, leader, succession[], rules{}, admitted[],
                          revoked[], created, updated}
  tombstones/<team>__<member>.json   {type:"revoke", team, member, by_machine, at}
"""

import argparse
import datetime
import json
import os
import random
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from .core import bridge_path, atomic_write

VALID_ROLES = ("member", "leader")
VALID_ADMISSION = ("open", "approved")


# ─── helpers ──────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _valid_name(name: str) -> bool:
    import re
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,30}", name or ""))


def _machine_id() -> str:
    """This machine's relay id (from relay.json), else 'local'."""
    try:
        cfg = json.loads((bridge_path() / "relay.json").read_text())
        return cfg.get("machine_id") or "local"
    except Exception:
        return "local"


def _identity_path(name: str) -> Path:
    return bridge_path() / "identities" / f"identity-{name}.json"


def _teams_path() -> Path:
    return bridge_path() / "teams.json"


def _load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def _list_identities() -> list:
    out = []
    for p in sorted(bridge_path().glob("identities/identity-*.json")):
        d = _load_json(p)
        if d and d.get("display_name"):
            out.append(d)
    return out


def _load_registry() -> dict:
    d = _load_json(_teams_path())
    return (d or {}).get("teams", {}) if d else {}


def _save_registry(reg: dict):
    atomic_write(_teams_path(), {"teams": reg})


def _list_team_files() -> list:
    return [t for t in _load_registry().values() if t and t.get("name")]


def _load_team(name: str):
    return _load_registry().get(name)


def _save_team(team: dict):
    team["updated"] = _now()
    reg = _load_registry()
    reg[team["name"]] = team
    _save_registry(reg)


# ── teams.json write lock (mirrors channel/server.mjs acquireTeamsLock) ──
# teams.json has multiple writers (this CLI + the long-running MCP servers), each doing
# read-merge-write. A sidecar lock <bridge>/teams.json.lock serializes them so a concurrent mutation
# can't clobber (a lost admit / leadership change). The lock must appear ATOMICALLY WITH its holder
# payload: an O_EXCL-create-then-write leaves an empty-file window where a waiter reads "", can't
# parse a holder, mis-judges it stale, and steals → two holders → the lost-update we're preventing
# (QA-found). Fix: write the payload to a temp file then os.link() it into place — link is atomic and
# fails if the lock exists, so it's never observable empty. Works cross-language (Node + Python hit
# the same link/rename/stat) on a local FS — never put the bridge on NFS. Steal a dead/over-aged
# holder via an atomic rename-to-claim (one breaker wins); release only if we still own it.
# max_hold >> longest plausible deschedule of a HEALTHY holder mid-section (~1ms): a live holder
# starved past this would be assumed-crashed, stolen, then resume and clobber. 30s = huge margin,
# still reclaims a dead holder within 30s. (Inherent to time-based stealing; see channel/server.mjs.)
# Env-overridable (CC2CC_LOCK_MAX_HOLD_MS) so QA can shrink it to provoke the steal window — must
# match the JS side and stay >> the real section in production.
def _env_pos(name, default):
    try:
        v = float(os.environ.get(name, ""))
        return v if v > 0 else default
    except (TypeError, ValueError):
        return default


_LOCK_MAX_HOLD_MS = _env_pos("CC2CC_LOCK_MAX_HOLD_MS", 30000)
_LOCK_ACQUIRE_TIMEOUT_S = _env_pos("CC2CC_LOCK_ACQUIRE_TIMEOUT_MS", 5000) / 1000.0  # fail loud sooner; caller retries


def _pid_alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by another user
    except (OSError, ValueError):
        return False


def _break_stale_lock(lock_path: Path):
    """Atomically remove a lock judged stale: rename aside (one racer wins) then delete."""
    brk = f"{lock_path}.break.{os.getpid()}.{random.random()}"
    try:
        os.rename(str(lock_path), brk)
        try:
            os.unlink(brk)
        except OSError:
            pass
    except FileNotFoundError:
        pass  # another racer already broke/took it


@contextmanager
def teams_lock():
    """Hold the teams.json sidecar lock for the whole read-merge-write. FAIL LOUD on timeout —
    never silently drop a team mutation."""
    lock_path = _teams_path().with_name("teams.json.lock")
    deadline = time.time() + _LOCK_ACQUIRE_TIMEOUT_S
    token = None
    while True:
        token = {"pid": os.getpid(), "ts": int(time.time() * 1000)}
        tmp = f"{lock_path}.tmp.{os.getpid()}.{random.random()}"
        with open(tmp, "w") as f:
            f.write(json.dumps(token))
        try:
            os.chmod(tmp, 0o660)
        except OSError:
            pass
        try:
            os.link(tmp, str(lock_path))  # atomic create-WITH-content; raises if held
            try:
                os.unlink(tmp)
            except OSError:
                pass
            break
        except FileExistsError:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        # Held by someone. Decide wait vs steal.
        holder = None
        try:
            holder = json.loads(lock_path.read_text())
        except Exception:
            pass
        if not holder:
            # No parseable holder (raced away, or legacy/torn empty lock). Don't blind-steal — steal
            # only if the FILE itself has aged past max_hold; else it's a just-created lock mid-claim.
            try:
                age_ms = time.time() * 1000 - lock_path.stat().st_mtime * 1000
            except OSError:
                age_ms = _LOCK_MAX_HOLD_MS + 1  # gone → just retry the link
            if age_ms > _LOCK_MAX_HOLD_MS:
                _break_stale_lock(lock_path)
                continue
        elif (not _pid_alive(holder.get("pid"))) or (
            time.time() * 1000 - holder.get("ts", 0) > _LOCK_MAX_HOLD_MS
        ):
            _break_stale_lock(lock_path)  # dead, or held longer than any real section
            continue
        elif time.time() > deadline:
            raise RuntimeError(
                f"teams.json lock busy (held by pid {holder.get('pid')}); "
                "aborting to avoid a lost mutation"
            )
        time.sleep(0.015 + random.random() * 0.035)  # jittered backoff
    try:
        yield
    finally:
        # Release only if the on-disk lock is still OURS — never delete a lock stolen + re-acquired.
        try:
            cur = json.loads(lock_path.read_text())
            if cur and cur.get("pid") == token["pid"] and cur.get("ts") == token["ts"]:
                lock_path.unlink()
        except Exception:
            pass


def with_teams_lock(fn):
    """Decorator: run a mutating command's full read-merge-write under the teams.json lock."""
    def wrapper(args):
        with teams_lock():
            return fn(args)
    return wrapper


DEFAULT_POLICY = {
    "messages": {"retention_days": 4, "stale_after_hours": 24, "max_age_days": 5},
    "teams": {"default_admission": "open", "sticky_leader": True},
    "identities": {"offline_after_seconds": 15, "expire_days": 30},
    "directory": {"active_seconds": 60, "expire_days": 4},
    "relay": {"encrypt_required": True},
}


def _load_policy() -> dict:
    d = _load_json(bridge_path() / "policy.json") or {}
    p = {k: dict(v) for k, v in DEFAULT_POLICY.items()}
    for k, v in d.items():
        if k in p and isinstance(v, dict):
            p[k].update(v)
        else:
            p[k] = v
    return p


def _new_team(name: str, leader=None) -> dict:
    pol = _load_policy()
    return {
        "name": name,
        "owner_machine": _machine_id(),
        "leader": leader,
        "succession": [],
        "rules": {
            "retention_days": pol["messages"]["retention_days"],
            "admission": pol["teams"]["default_admission"],
            "sticky_leader": pol["teams"]["sticky_leader"],
        },
        "admitted": [],
        "revoked": [],
        "created": _now(),
        "updated": _now(),
    }


def _save_identity(name, teams, agent_id=None):
    # Identity carries no role — leadership/membership-role is defined by teams.json.
    ident = {
        "display_name": name,
        "agent_id": agent_id or str(uuid.uuid4()),
        "created": _now(),
        "last_seen": _now(),
        "teams": teams,
    }
    atomic_write(_identity_path(name), ident)
    return ident


def _role_of(name: str) -> str:
    """Derived role: 'leader' if this agent leads any team in the registry, else 'member'."""
    for t in _load_registry().values():
        if t and t.get("leader") == name:
            return "leader"
    return "member"


def _heartbeat_status(name: str):
    """online/offline + last_seen from status/<name>-heartbeat.json (best-effort)."""
    hb = _load_json(bridge_path() / "status" / f"{name}-heartbeat.json")
    if not hb:
        return ("unknown", None)
    ts = hb.get("timestamp") or hb.get("heartbeat")
    active = hb.get("status") == "active"
    if ts:
        try:
            age = (datetime.datetime.now(datetime.timezone.utc)
                   - datetime.datetime.fromisoformat(ts.replace("Z", "+00:00"))).total_seconds()
            active = active and age <= 15
        except Exception:
            pass
    return ("online" if active else "offline", ts)


def _emit_tombstone(team: str, member: str):
    ts = {"type": "revoke", "team": team, "member": member,
          "by_machine": _machine_id(), "at": _now()}
    atomic_write(bridge_path() / "tombstones" / f"{team}__{member}.json", ts)
    return ts


def _err(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def _ok(msg: str):
    print(msg)


# ─── identity / member commands ─────────────────────────────────────────────

@with_teams_lock
def cmd_member_add(args):
    name = args.name
    if not _valid_name(name):
        _err(f"invalid name '{name}' (use lowercase a-z, 0-9, hyphens, max 31)")
    teams = args.team or ["cc2cc"]
    as_leader = (args.role == "leader")  # --role leader → make them the team's leader (in teams.json)
    if _identity_path(name).exists() and not args.force:
        _err(f"identity '{name}' already exists (use --force to overwrite)")
    _save_identity(name, teams)
    # Admit to each named team's roster (create the team if this machine owns it). Role lives
    # in the team registry: --role leader designates them leader there (not on the identity).
    admitted_to = []
    for t in teams:
        team = _load_team(t) or _new_team(t, leader=name if as_leader else None)
        if name in team.get("revoked", []):
            team["revoked"].remove(name)
        if name not in team["admitted"]:
            team["admitted"].append(name)
        if as_leader:
            team["leader"] = name
        _save_team(team)
        admitted_to.append(t)
    _ok(f"added '{name}'{' (leader)' if as_leader else ''} to: {', '.join(admitted_to)}")


def cmd_member_list(args):
    rows = []
    for d in _list_identities():
        if args.team and args.team not in (d.get("teams") or []):
            continue
        status, last = _heartbeat_status(d["display_name"])
        rows.append((d["display_name"], ",".join(d.get("teams") or []), _role_of(d["display_name"]), status))
    if not rows:
        _ok("(no local members)")
        return
    w = max(len(r[0]) for r in rows)
    for n, teams, role, status in rows:
        _ok(f"  {n.ljust(w)}  teams={teams:<16} role={role:<7} {status}")


@with_teams_lock
def cmd_member_remove(args):
    """Home-machine authority: delete the member's identity entirely."""
    p = _identity_path(args.name)
    if not p.exists():
        _err(f"no such local member '{args.name}'")
    ident = _load_json(p) or {}
    p.unlink()
    # Drop from any local team rosters we own.
    for t in (ident.get("teams") or []):
        team = _load_team(t)
        if team and args.name in team.get("admitted", []):
            team["admitted"].remove(args.name)
            _save_team(team)
    _ok(f"deleted member '{args.name}'")


@with_teams_lock
def cmd_member_revoke(args):
    """Team-owner authority: revoke a member's PARTICIPATION in a team (tombstone).
    Does NOT delete the member's identity."""
    team = _load_team(args.team)
    if not team:
        _err(f"this machine does not own team '{args.team}' (team '{args.team}' not on this machine)")
    if team["owner_machine"] != _machine_id():
        _err(f"team '{args.team}' is owned by '{team['owner_machine']}', not this machine")
    member = args.name
    if member in team.get("admitted", []):
        team["admitted"].remove(member)
    if member not in team.get("revoked", []):
        team["revoked"].append(member)
    if team.get("leader") == member:
        team["leader"] = None
    _save_team(team)
    _emit_tombstone(args.team, member)
    _ok(f"removed '{member}' from '{args.team}'")


# ─── team / rules commands ───────────────────────────────────────────────────

@with_teams_lock
def cmd_team_create(args):
    if not _valid_name(args.name):
        _err(f"invalid team name '{args.name}'")
    if _load_team(args.name) and not args.force:
        _err(f"team '{args.name}' already exists (use --force)")
    team = _new_team(args.name, leader=args.leader)
    if args.retention_days is not None:
        team["rules"]["retention_days"] = args.retention_days
    if args.admission:
        team["rules"]["admission"] = args.admission
    if args.leader:
        team["admitted"].append(args.leader)
    _save_team(team)
    _ok(f"team '{args.name}' created (owner={team['owner_machine']}, leader={args.leader or 'none'})")


def cmd_team_list(args):
    teams = _list_team_files()
    if not teams:
        _ok("(no teams owned by this machine)")
        return
    for t in teams:
        _ok(f"  {t['name']:<14} owner={t['owner_machine']:<10} leader={t.get('leader') or '-':<12} "
            f"members={len(t.get('admitted', []))} retention={t['rules'].get('retention_days')}d "
            f"admission={t['rules'].get('admission')}")


def cmd_team_show(args):
    team = _load_team(args.name)
    if not team:
        _err(f"no team '{args.name}' on this machine")
    print(json.dumps(team, indent=2))


@with_teams_lock
def cmd_team_set(args):
    team = _load_team(args.name)
    if not team:
        _err(f"no team '{args.name}' on this machine")
    key, val = args.key, args.value
    # typed coercion for known rule keys
    if key == "retention_days":
        val = int(val)
    elif key == "sticky_leader":
        val = val.lower() in ("1", "true", "yes", "on")
    elif key == "admission" and val not in VALID_ADMISSION:
        _err(f"admission must be one of {VALID_ADMISSION}")
    team["rules"][key] = val
    _save_team(team)
    _ok(f"team '{args.name}' rule {key} = {val!r}")


@with_teams_lock
def cmd_team_leader(args):
    """Operator override: designate the leader for a team this machine owns.
    Leadership lives in the team registry (teams.json) — the runtime derives role from it."""
    team = _load_team(args.name)
    if not team:
        _err(f"no team '{args.name}' on this machine")
    prev = team.get("leader")
    team["leader"] = args.agent
    if args.agent and args.agent not in team["admitted"]:
        team["admitted"].append(args.agent)
    _save_team(team)
    _ok(f"team '{args.name}' leader set to '{args.agent}'" + (f" (was '{prev}')" if prev else ""))


@with_teams_lock
def cmd_team_succession(args):
    team = _load_team(args.name)
    if not team:
        _err(f"no team '{args.name}' on this machine")
    order = [s.strip() for s in args.order.split(",") if s.strip()]
    team["succession"] = order
    _save_team(team)
    _ok(f"team '{args.name}' succession = {order}")


@with_teams_lock
def cmd_team_admit(args):
    team = _load_team(args.name)
    if not team:
        _err(f"no team '{args.name}' on this machine")
    if args.agent in team.get("revoked", []):
        team["revoked"].remove(args.agent)
    if args.agent not in team["admitted"]:
        team["admitted"].append(args.agent)
    _save_team(team)
    _ok(f"admitted '{args.agent}' to team '{args.name}'")


# ─── directory / GAB ─────────────────────────────────────────────────────────

def cmd_gab(args):
    """Federated Global Address Book: local members (authoritative here), teams we own
    (policy), and the remote replica of other machines' contributions."""
    print("=== Federated Global Address Book ===")
    print("LOCAL members (this machine's authority):")
    locals_ = _list_identities()
    if not locals_:
        print("  (none)")
    for d in locals_:
        status, _ = _heartbeat_status(d["display_name"])
        teams = ",".join(d.get("teams") or [])
        print(f"  {d['display_name']:<18} teams={teams:<18} role={_role_of(d['display_name']):<7} {status}")

    print("\nTEAMS owned here (policy governs):")
    teamfiles = _list_team_files()
    if not teamfiles:
        print("  (none)")
    for t in teamfiles:
        print(f"  {t['name']:<14} leader={t.get('leader') or '-':<12} "
              f"admitted={t.get('admitted', [])} revoked={t.get('revoked', [])} "
              f"retention={t['rules'].get('retention_days')}d admission={t['rules'].get('admission')}")

    print("\nREMOTE replica (other machines' contributions, from remote-teams.json):")
    rt = _load_json(bridge_path() / "remote-teams.json") or {}
    if not rt:
        print("  (none / relay not active)")
    now_ms = datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000
    for team, data in rt.items():
        polled = data.get("polled_at") or 0
        state = "active" if (now_ms - polled) < 60000 else "known/offline"
        agents = ",".join((data.get("agents") or {}).keys())
        print(f"  {team:<14} machine={data.get('machine_id', '?'):<10} {state:<14} members={agents}")


def cmd_policy_show(args):
    print(json.dumps(_load_policy(), indent=2))


def cmd_daemon(args):
    """Control the per-host bridge daemon — thin wrapper over `node channel/daemon.mjs`."""
    import shutil, subprocess
    node = shutil.which("node")
    if not node:
        _err("node not found on PATH (required to control the daemon)")
    daemon_js = Path(__file__).resolve().parent.parent / "channel" / "daemon.mjs"
    if not daemon_js.exists():
        _err(f"daemon.mjs not found at {daemon_js}")
    cmd = [node, str(daemon_js), "--" + args.action]
    if args.action == "start" and getattr(args, "service", False):
        cmd.append("--service")
    sys.exit(subprocess.run(cmd).returncode)


def main():
    parser = argparse.ArgumentParser(prog="cc2cc-admin",
                                     description="cc2cc operator/administration CLI (local-machine authority)")
    sub = parser.add_subparsers(dest="group", required=True)

    # member ...
    m = sub.add_parser("member", help="manage local members (this machine's authority)")
    msub = m.add_subparsers(dest="action", required=True)
    p = msub.add_parser("add", help="provision a local member + admit to team(s)")
    p.add_argument("name")
    p.add_argument("--team", action="append", help="team to join (repeatable)")
    p.add_argument("--role", choices=VALID_ROLES, default="member")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_member_add)
    p = msub.add_parser("list", help="list local members")
    p.add_argument("--team")
    p.set_defaults(func=cmd_member_list)
    p = msub.add_parser("remove", help="delete a local member's identity (home authority)")
    p.add_argument("name")
    p.set_defaults(func=cmd_member_remove)
    p = msub.add_parser("revoke", help="revoke a member's participation in a team (tombstone)")
    p.add_argument("name")
    p.add_argument("--team", required=True)
    p.set_defaults(func=cmd_member_revoke)

    # team ...
    t = sub.add_parser("team", help="administer teams + rules (teams this machine owns)")
    tsub = t.add_subparsers(dest="action", required=True)
    p = tsub.add_parser("create", help="create a team owned by this machine")
    p.add_argument("name")
    p.add_argument("--leader")
    p.add_argument("--retention-days", type=int, dest="retention_days")
    p.add_argument("--admission", choices=VALID_ADMISSION)
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_team_create)
    p = tsub.add_parser("list", help="list teams owned by this machine")
    p.set_defaults(func=cmd_team_list)
    p = tsub.add_parser("show", help="show a team's full policy")
    p.add_argument("name")
    p.set_defaults(func=cmd_team_show)
    p = tsub.add_parser("set", help="set a team rule (retention_days|admission|sticky_leader|...)")
    p.add_argument("name"); p.add_argument("key"); p.add_argument("value")
    p.set_defaults(func=cmd_team_set)
    p = tsub.add_parser("leader", help="operator override: designate the team leader")
    p.add_argument("name"); p.add_argument("agent")
    p.set_defaults(func=cmd_team_leader)
    p = tsub.add_parser("succession", help="set succession order (comma-separated)")
    p.add_argument("name"); p.add_argument("order")
    p.set_defaults(func=cmd_team_succession)
    p = tsub.add_parser("admit", help="admit a member to the team")
    p.add_argument("name"); p.add_argument("agent")
    p.set_defaults(func=cmd_team_admit)

    # gab / directory
    p = sub.add_parser("gab", help="show the federated Global Address Book")
    p.set_defaults(func=cmd_gab)
    p = sub.add_parser("directory", help="alias for gab")
    p.set_defaults(func=cmd_gab)

    # policy
    pol = sub.add_parser("policy", help="federation GAB policy (message-handling defaults)")
    polsub = pol.add_subparsers(dest="action", required=True)
    p = polsub.add_parser("show", help="show the effective policy (defaults + policy.json)")
    p.set_defaults(func=cmd_policy_show)

    # daemon (control the per-host bridge daemon; wraps `node channel/daemon.mjs`)
    d = sub.add_parser("daemon", help="control the per-host bridge daemon")
    dsub = d.add_subparsers(dest="action", required=True)
    dsub.add_parser("status", help="show daemon status as JSON").set_defaults(func=cmd_daemon)
    dsub.add_parser("stop", help="stop the daemon (clean SIGTERM)").set_defaults(func=cmd_daemon)
    dsub.add_parser("restart", help="restart the daemon (preserves mode)").set_defaults(func=cmd_daemon)
    ds = dsub.add_parser("start", help="start the daemon detached (--service = always-on, no idle-exit)")
    ds.add_argument("--service", action="store_true", help="run in service mode (no idle-exit)")
    ds.set_defaults(func=cmd_daemon)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
