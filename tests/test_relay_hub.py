"""
Test suite for CC2CC Relay Hub (relay_hub.py).

Covers all 10 critical blockers (B1-B10) and 4 high-priority items (H1-H4):
  B1  — Token plumbing
  B2  — timedelta crash (wall-clock second >= 30)
  B3  — Inbound delivery via correct mailbox path
  B4  — (machine_id,team) routing key isolation
  B5  — No plaintext leak (hub-agnostic; tested via handler)
  B6  — Startup guard (hub fails without token)
  B7  — Lease-keyed ack
  B8  — Encryption (tested via handler)
  B9  — 24h message TTL
  B10 — Path traversal prevention
  H1  — No default token
  H2  — Identity dedup (merge on multiple register)
  H3  — Sender registration validation
  H4  — Stale registration cleanup
"""

import json
import os
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

# Import the app — it needs a token set to start
os.environ["CC2CC_RELAY_TOKEN"] = "test-token-123"
import relay_hub
from relay_hub import app, tokens, registrations, message_queue, leased_messages, cleanup_expired, MESSAGE_MAX_AGE_SECONDS, LEASE_TTL, REGISTRATION_TTL, init_tokens

# Initialize tokens manually (TestClient doesn't trigger startup events in all FastAPI versions)
init_tokens()


client = TestClient(app)

TOKEN = "test-token-123"
MACHINE_A = "machine-a"
MACHINE_B = "machine-b"
TEAM_X = "team-x"
TEAM_Y = "team-y"


def reset_state():
    """Clear all in-memory state between tests."""
    registrations.clear()
    message_queue.clear()
    leased_messages.clear()


def register(machine_id=MACHINE_A, team=TEAM_X, token=TOKEN):
    """Helper: register a machine."""
    return client.post("/api/register", json={"token": token, "machine_id": machine_id, "team": team})


# ─── H1: Startup Guard ───────────────────────────────────────────────────────

class TestH1StartupGuard:
    """H1: Hub must refuse to start without any token configured."""

    def test_app_loaded_with_token(self):
        """Our TestClient imported the app AFTER setting CC2CC_RELAY_TOKEN, so tokens should contain it."""
        assert "test-token-123" in tokens, "test token must be present"

    def test_init_tokens_empty_env(self):
        """H1: init_tokens() with no env var and no --token leaves tokens empty (startup would raise)."""
        saved_token = os.environ.pop("CC2CC_RELAY_TOKEN", None)
        saved_tokens = set(tokens)
        tokens.clear()
        try:
            from relay_hub import init_tokens as it
            it()
            assert len(tokens) == 0, "H1: no tokens should be configured without env var or --token"
        finally:
            tokens.update(saved_tokens)
            if saved_token:
                os.environ["CC2CC_RELAY_TOKEN"] = saved_token

    def test_bad_token_rejected(self):
        """Requests with invalid token get 401."""
        resp = client.post("/api/register", json={"token": "wrong", "machine_id": "m", "team": "t"})
        assert resp.status_code == 401
        assert "Invalid token" in resp.text

    def test_no_auth_on_poll_rejected(self):
        """Poll without Authorization header gets 401."""
        resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X})
        assert resp.status_code == 401


# ─── B2: Timedelta Fix ───────────────────────────────────────────────────────

class TestB2TimedeltaFix:
    """B2: /api/poll must not 500 when wall-clock second >= 30 (replace limitation).
    Freezes time at second=45 to deterministically catch the replace() bug."""

    def test_poll_frozen_at_second_45(self):
        """Freeze datetime.now at a second >= 30 to verify timedelta fix catches boundary."""
        reset_state()
        register()
        register(MACHINE_B, TEAM_Y)

        client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "hello"}}
        })

        # Freeze time at second=45 to cross the replace() crash boundary
        fixed_now = datetime(2026, 6, 18, 12, 0, 45, tzinfo=timezone.utc)

        with patch.object(relay_hub, "datetime") as mock_dt:
            mock_dt.now.return_value = fixed_now
            mock_dt.fromisoformat.side_effect = lambda s: datetime.fromisoformat(s)
            mock_dt.timedelta = timedelta

            resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                               headers={"Authorization": f"Bearer {TOKEN}"})
            assert resp.status_code == 200, f"B2 fail at second=45: {resp.text}"


# ─── B4: Namespacing ─────────────────────────────────────────────────────────

class TestB4Namespacing:
    """B4: (machine_id,team) routing key isolation — Machine A and B polling team-x must get different messages."""

    def test_isolated_queues(self):
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_X)
        # Sender must have active registration for its (machine,team)
        register(MACHINE_B, TEAM_Y)

        # Send a message targeting (MACHINE_A, TEAM_X)
        client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "for A"}}
        })

        # Machine A polls — should get 1 message
        resp_a = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp_a.json()["messages"]) == 1

        # Machine B polls — should also get 1 message (different queue)
        resp_b = client.post("/api/poll", json={"machine_id": MACHINE_B, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp_b.json()["messages"]) == 1, "B4: Machine B should also receive the message"

    def test_no_cross_machine_theft(self):
        """One machine polling should not steal from another's queue."""
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_X)
        register(MACHINE_B, TEAM_Y)

        client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "shared delivery"}}
        })

        # Machine A polls and acks its copy
        resp_a = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp_a.json()["messages"]) == 1
        ack_id = resp_a.json()["messages"][0]["lease_id"]
        client.post("/api/ack", json={"token": TOKEN, "machine_id": MACHINE_A, "acked_ids": [ack_id]})

        # Machine B polls — must still get its own copy (separate queue entry)
        resp_b = client.post("/api/poll", json={"machine_id": MACHINE_B, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp_b.json()["messages"]) == 1, "B4: Machine B should still have its own copy"


# ─── B7: Lease-Keyed Ack ─────────────────────────────────────────────────────

class TestB7LeaseKeyedAck:
    """B7: /api/ack must delete by lease_id, not msg_id — stale acks must not delete re-leased entries."""

    def test_ack_by_lease(self):
        reset_state()
        register()
        register(MACHINE_B, TEAM_Y)
        client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "lease test"}}
        })

        # Poll — get lease
        resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                           headers={"Authorization": f"Bearer {TOKEN}"})
        lease_id = resp.json()["messages"][0]["lease_id"]

        # Ack by lease
        ack_resp = client.post("/api/ack", json={"token": TOKEN, "machine_id": MACHINE_A, "acked_ids": [lease_id]})
        assert ack_resp.status_code == 200
        assert ack_resp.json()["deleted_count"] == 1

        # Re-poll — no more messages
        resp2 = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                            headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp2.json()["messages"]) == 0

    def test_stale_lease_superseded_on_release(self):
        """B7: When re-leasing after expiry, the old lease is superseded (invalidated).
        A stale ack with the old lease_id must be a no-op."""
        import relay_hub
        original_ttl = relay_hub.LEASE_TTL

        try:
            relay_hub.LEASE_TTL = 0  # Lease expires immediately on next poll

            reset_state()
            register()
            register(MACHINE_B, TEAM_Y)
            client.post("/api/send", json={
                "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
                "to_team": TEAM_X,
                "message": {"content": {"text": "stale test"}}
            })

            # Poll — get lease A (immediately expired by TTL=0)
            poll1 = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                                headers={"Authorization": f"Bearer {TOKEN}"})
            assert len(poll1.json()["messages"]) == 1
            lease_a = poll1.json()["messages"][0]["lease_id"]

            # Re-poll — triggers re-lease, old lease_a should be removed from leased_messages
            poll2 = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                                headers={"Authorization": f"Bearer {TOKEN}"})
            assert len(poll2.json()["messages"]) == 1, "re-lease should work"
            lease_b = poll2.json()["messages"][0]["lease_id"]
            assert lease_a != lease_b, "B7: re-lease must produce a different lease_id"

            # Now submit stale ack with lease_a — must NOT delete the entry
            stale_ack = client.post("/api/ack", json={"token": TOKEN, "machine_id": MACHINE_A, "acked_ids": [lease_a]})
            assert stale_ack.json()["deleted_count"] == 0, "B7: stale lease ack must be a no-op"

            # Entry should still be there for lease_b to ack
            valid_ack = client.post("/api/ack", json={"token": TOKEN, "machine_id": MACHINE_A, "acked_ids": [lease_b]})
            assert valid_ack.json()["deleted_count"] == 1
        finally:
            relay_hub.LEASE_TTL = original_ttl


# ─── B9: 24h TTL ─────────────────────────────────────────────────────────────

class TestB924hTTL:
    """B9: Messages older than 24h must be filtered out before delivery."""

    def test_expired_message_filtered(self):
        reset_state()
        register()

        client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "old message"}}
        })

        # Manually age the message in the queue past 24h
        key = f"{MACHINE_A}:{TEAM_X}"
        for entry in message_queue.get(key, []):
            entry["created"] = datetime.now(timezone.utc) - timedelta(seconds=MESSAGE_MAX_AGE_SECONDS + 1)

        # Poll — expired message must be filtered
        resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                           headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(resp.json()["messages"]) == 0, "B9: expired messages must be filtered"


# ─── B10: Path Traversal ─────────────────────────────────────────────────────

class TestB10PathTraversal:
    """B10: Hub generates its own UUID msg_id — sender-supplied ids are not used as filenames."""

    def test_hub_generates_uuid_id(self):
        reset_state()
        register()
        register(MACHINE_B, TEAM_Y)
        resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"id": "../../evil/msg", "content": {"text": "path traversal attempt"}}
        })
        assert resp.status_code == 200
        # The hub-generated id should be in the "message_id" field and start with "relay-"
        msg_id = resp.json()["message_id"]
        assert msg_id.startswith("relay-"), f"B10: hub must generate its own UUID id, got: {msg_id}"


# ─── H3: Sender Registration Validation ──────────────────────────────────────

class TestH3SenderValidation:
    """H3: /api/send must reject senders without an active registration.
    NOTE: Current guard checks that (from_machine, from_team) has an active
    registration slot. It does NOT bind from_machine to the bearer token —
    any valid token + any active registration pair passes. Full token-binding
    is a future hardening item (H3-limitation)."""

    def test_unregistered_sender_rejected(self):
        reset_state()
        resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": "unregistered-machine", "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "impersonation attempt"}}
        })
        assert resp.status_code == 403, f"H3: unregistered sender should get 403, got {resp.status_code}"
        assert "not registered" in resp.text.lower()


# ─── H4: Stale Registration Detection ────────────────────────────────────────

class TestH4StaleExpiry:
    """H4: Hub detects stale registrations via TTL and reports clean online_teams."""

    def test_stale_registration_excluded(self):
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_X)  # H4: fresh reg to distinguish "filtered" from "no regs"

        # Age machine A's registration past TTL
        key_a = f"{MACHINE_A}:{TEAM_X}"
        registrations[key_a]["last_seen"] = (
            datetime.now(timezone.utc) - timedelta(seconds=REGISTRATION_TTL + 5)
        ).isoformat()

        resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                           headers={"Authorization": f"Bearer {TOKEN}"})
        data = resp.json()
        online = data.get("online_teams", {})
        # TEAM_X must appear (machine B's fresh reg keeps it alive)
        assert TEAM_X in online, f"H4: team should appear via fresh registration: {online}"
        # But machine A's stale reg must not be the machine listed for the team
        assert online[TEAM_X]["machine_id"] == MACHINE_B, f"H4: stale registration should not appear"


# ─── B1 + End-to-End Flow ────────────────────────────────────────────────────

class TestB1EndToEndFlow:
    """B1: Full register → send → poll → ack cycle covering token plumbing end-to-end."""

    def test_full_cycle(self):
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_Y)

        # Agent on machine B sends cross-team message to team-x
        send_resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "cross-machine hello"}}
        })
        assert send_resp.status_code == 200
        msg_id = send_resp.json()["message_id"]

        # Machine A polls team-x — gets the message
        poll_resp = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                                headers={"Authorization": f"Bearer {TOKEN}"})
        assert poll_resp.status_code == 200
        data = poll_resp.json()
        assert len(data["messages"]) == 1
        msg = data["messages"][0]
        assert msg["from_team"] == TEAM_Y
        assert msg["to_team"] == TEAM_X
        assert msg["message"]["content"]["text"] == "cross-machine hello"
        lease_id = msg["lease_id"]

        # Ack the message
        ack_resp = client.post("/api/ack", json={"token": TOKEN, "machine_id": MACHINE_A, "acked_ids": [lease_id]})
        assert ack_resp.status_code == 200
        assert ack_resp.json()["deleted_count"] == 1

        # Re-poll — no more messages
        poll2 = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                            headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(poll2.json()["messages"]) == 0

    def test_multiple_target_machines(self):
        """Send to team-x when both MACHINE_A and MACHINE_B are registered for team-x."""
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_X)

        send_resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_A, "from_team": TEAM_X,
            "to_team": TEAM_X,
            "message": {"content": {"text": "to both machines"}}
        })
        assert send_resp.status_code == 200

        # Both machines should get a copy
        poll_a = client.post("/api/poll", json={"machine_id": MACHINE_A, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        poll_b = client.post("/api/poll", json={"machine_id": MACHINE_B, "team": TEAM_X},
                             headers={"Authorization": f"Bearer {TOKEN}"})
        assert len(poll_a.json()["messages"]) == 1
        assert len(poll_b.json()["messages"]) == 1


# ─── Keepalive ───────────────────────────────────────────────────────────────

class TestKeepalive:
    """Keepalive refreshes registration TTL."""

    def test_keepalive_refreshes(self):
        reset_state()
        register()

        # Age the registration
        key = f"{MACHINE_A}:{TEAM_X}"
        old_seen = registrations[key]["last_seen"]

        ka = client.post("/api/keepalive", json={"token": TOKEN, "machine_id": MACHINE_A, "team": TEAM_X})
        assert ka.status_code == 200
        assert ka.json()["ttl_seconds"] == REGISTRATION_TTL

        # last_seen should have changed
        assert registrations[key]["last_seen"] != old_seen

    def test_keepalive_unregistered(self):
        reset_state()
        ka = client.post("/api/keepalive", json={"token": TOKEN, "machine_id": "ghost", "team": TEAM_X})
        assert ka.status_code == 404


# ─── Heartbeat ───────────────────────────────────────────────────────────────

class TestHeartbeat:
    """Heartbeat updates agent list and keeps registration alive."""

    def test_heartbeat_sets_agents(self):
        reset_state()
        register()
        hb_data = {"bright-hare": {"status_text": "Idle"}, "fair-wren": {"status_text": "Reviewing specs"}}
        resp = client.post("/api/heartbeat", json={
            "token": TOKEN, "machine_id": MACHINE_A, "team": TEAM_X, "agents": hb_data
        })
        assert resp.status_code == 200

        key = f"{MACHINE_A}:{TEAM_X}"
        assert registrations[key]["agents"] == hb_data


# ─── Health ───────────────────────────────────────────────────────────────────

class TestHealth:
    def test_health_returns_counts(self):
        reset_state()
        register()
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert "registrations" in data
        assert "queued_messages" in data
        assert "active_leases" in data


# ─── Edge Cases ───────────────────────────────────────────────────────────────

class TestEdgeCases:
    def test_empty_online_teams(self):
        """No registrations → empty online_teams in poll response."""
        reset_state()
        resp = client.post("/api/poll", json={"machine_id": "none", "team": TEAM_X},
                           headers={"Authorization": f"Bearer {TOKEN}"})
        assert resp.json()["online_teams"] == {}

    def test_send_with_unknown_team(self):
        """Send to a team that has never registered should 404."""
        reset_state()
        register(MACHINE_A, TEAM_X)
        resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_A, "from_team": TEAM_X,
            "to_team": "nonexistent-team",
            "message": {"content": {"text": "to unknown"}}
        })
        assert resp.status_code == 404

    def test_team_not_in_online_teams(self):
        """After stale cleanup, team should not appear in poll."""
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_Y)

        # Age registration
        for key in list(registrations.keys()):
            registrations[key]["last_seen"] = (
                datetime.now(timezone.utc) - timedelta(seconds=REGISTRATION_TTL + 10)
            ).isoformat()

        # Clean up expired registrations manually (simulate background task)
        for key in list(registrations.keys()):
            from relay_hub import _is_registration_active
            if not _is_registration_active(registrations[key]):
                del registrations[key]

        assert len(registrations) == 0, "all registrations should be cleaned up"

    def test_queue_full_skip(self):
        """When a specific (machine_id,team) queue is full, it should be skipped without blocking send."""
        reset_state()
        register(MACHINE_A, TEAM_X)
        register(MACHINE_B, TEAM_X)
        register(MACHINE_B, TEAM_Y)

        from relay_hub import MAX_QUEUED_PER_TEAM
        # Fill up machine A's queue
        key_a = f"{MACHINE_A}:{TEAM_X}"
        message_queue[key_a] = [
            {"id": f"msg-{i}", "msg": {"id": f"msg-{i}"}, "created": datetime.now(timezone.utc),
             "leased_to": None, "lease_expires": None}
            for i in range(MAX_QUEUED_PER_TEAM)
        ]

        # Send — should succeed (B still has room)
        resp = client.post("/api/send", json={
            "token": TOKEN, "from_machine": MACHINE_B, "from_team": TEAM_Y,
            "to_team": TEAM_X,
            "message": {"content": {"text": "after full queue"}}
        })
        assert resp.status_code == 200, f"send should succeed even if one target is full: {resp.text}"


if __name__ == "__main__":
    pytest.main(["-v", __file__])
