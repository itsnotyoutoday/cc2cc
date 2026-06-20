"""Tests for cc2cc_admin (federation governance CLI)."""

import json
from types import SimpleNamespace

import pytest

from cc2cc import admin
from cc2cc.core import bridge_path


@pytest.fixture
def bridge(tmp_path, monkeypatch):
    monkeypatch.setenv("CC2CC_BRIDGE_DIR", str(tmp_path))
    (tmp_path / "status").mkdir()
    (tmp_path / "relay.json").write_text(json.dumps({"machine_id": "testbox"}))
    return tmp_path


def _team(bridge, name):
    return json.loads((bridge / "teams.json").read_text())["teams"][name]


def _ident(bridge, name):
    return json.loads((bridge / "identities" / f"identity-{name}.json").read_text())


def _ident_path(bridge, name):
    return bridge / "identities" / f"identity-{name}.json"


def test_team_create_and_rules(bridge):
    admin.cmd_team_create(SimpleNamespace(name="beta", leader="beta-lead",
                                          retention_days=5, admission="approved", force=False))
    t = _team(bridge, "beta")
    assert t["owner_machine"] == "testbox"
    assert t["leader"] == "beta-lead"
    assert t["rules"]["retention_days"] == 5
    assert t["rules"]["admission"] == "approved"
    assert "beta-lead" in t["admitted"]

    admin.cmd_team_set(SimpleNamespace(name="beta", key="retention_days", value="7"))
    assert _team(bridge, "beta")["rules"]["retention_days"] == 7  # coerced to int


def test_member_add_provisions_identity_and_admits(bridge):
    admin.cmd_team_create(SimpleNamespace(name="beta", leader=None,
                                          retention_days=None, admission=None, force=False))
    admin.cmd_member_add(SimpleNamespace(name="beta-mem", team=["beta"], role="member", force=False))
    ident = _ident(bridge, "beta-mem")
    assert ident["display_name"] == "beta-mem"
    assert ident["teams"] == ["beta"]
    assert "role" not in ident  # role is NOT stored on the identity
    assert "agent_id" in ident and len(ident["agent_id"]) >= 32
    assert "beta-mem" in _team(bridge, "beta")["admitted"]


def test_member_add_creates_team_if_missing(bridge):
    admin.cmd_member_add(SimpleNamespace(name="alpha-lead", team=["alpha"], role="leader", force=False))
    t = _team(bridge, "alpha")
    assert t["leader"] == "alpha-lead"
    assert "alpha-lead" in t["admitted"]


def test_revoke_removes_participation_not_identity(bridge):
    admin.cmd_member_add(SimpleNamespace(name="beta-third", team=["beta"], role="member", force=False))
    assert _ident_path(bridge, "beta-third").exists()
    admin.cmd_member_revoke(SimpleNamespace(name="beta-third", team="beta"))
    t = _team(bridge, "beta")
    assert "beta-third" not in t["admitted"]
    assert "beta-third" in t["revoked"]
    # Tombstone emitted
    assert (bridge / "tombstones" / "beta__beta-third.json").exists()
    ts = json.loads((bridge / "tombstones" / "beta__beta-third.json").read_text())
    assert ts["type"] == "revoke" and ts["member"] == "beta-third" and ts["by_machine"] == "testbox"
    # Identity is NOT deleted (home-machine authority)
    assert _ident_path(bridge, "beta-third").exists()


def test_member_remove_deletes_identity(bridge):
    admin.cmd_member_add(SimpleNamespace(name="gone", team=["beta"], role="member", force=False))
    admin.cmd_member_remove(SimpleNamespace(name="gone"))
    assert not _ident_path(bridge, "gone").exists()
    assert "gone" not in _team(bridge, "beta")["admitted"]


def test_team_leader_override(bridge):
    admin.cmd_member_add(SimpleNamespace(name="beta-lead", team=["beta"], role="leader", force=False))
    admin.cmd_member_add(SimpleNamespace(name="beta-mem", team=["beta"], role="member", force=False))
    # Operator override: hand leadership to beta-mem (recorded in teams.json, not identities)
    admin.cmd_team_leader(SimpleNamespace(name="beta", agent="beta-mem"))
    assert _team(bridge, "beta")["leader"] == "beta-mem"
    # Role is derived from the team registry, not stored on identities.
    assert admin._role_of("beta-mem") == "leader"
    assert admin._role_of("beta-lead") == "member"
    assert "role" not in _ident(bridge, "beta-mem")


def test_succession_and_admit(bridge):
    admin.cmd_team_create(SimpleNamespace(name="beta", leader="beta-lead",
                                          retention_days=None, admission=None, force=False))
    admin.cmd_team_succession(SimpleNamespace(name="beta", order="beta-mem, beta-third"))
    assert _team(bridge, "beta")["succession"] == ["beta-mem", "beta-third"]
    admin.cmd_team_admit(SimpleNamespace(name="beta", agent="beta-mem"))
    assert "beta-mem" in _team(bridge, "beta")["admitted"]


def test_invalid_name_rejected(bridge):
    with pytest.raises(SystemExit):
        admin.cmd_member_add(SimpleNamespace(name="Bad Name", team=["beta"], role="member", force=False))


def test_revoke_requires_local_ownership(bridge):
    # No team file → cannot revoke
    with pytest.raises(SystemExit):
        admin.cmd_member_revoke(SimpleNamespace(name="x", team="nonexistent"))


def test_gab_runs(bridge, capsys):
    admin.cmd_member_add(SimpleNamespace(name="beta-lead", team=["beta"], role="leader", force=False))
    admin.cmd_gab(SimpleNamespace())
    out = capsys.readouterr().out
    assert "Federated Global Address Book" in out
    assert "beta-lead" in out


def test_policy_defaults_flow_into_team_create(bridge):
    # policy.json overrides the team-creation defaults.
    (bridge / "policy.json").write_text(json.dumps({
        "messages": {"retention_days": 9},
        "teams": {"default_admission": "approved"},
    }))
    admin.cmd_team_create(SimpleNamespace(name="gamma", leader=None,
                                          retention_days=None, admission=None, force=False))
    t = _team(bridge, "gamma")
    assert t["rules"]["retention_days"] == 9
    assert t["rules"]["admission"] == "approved"


def test_policy_show(bridge, capsys):
    admin.cmd_policy_show(SimpleNamespace())
    out = json.loads(capsys.readouterr().out)
    assert out["messages"]["retention_days"] == 4  # built-in default
    assert "directory" in out
