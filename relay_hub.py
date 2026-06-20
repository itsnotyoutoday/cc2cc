#!/usr/bin/env python3
"""
CC2CC Relay Hub v1

Lightweight HTTP store-and-forward relay for cross-machine message delivery.
In-memory storage — messages are lost on restart.

Usage:
    python3 relay_hub.py --token SECRET [--port 8080] [--host 0.0.0.0]
"""

import argparse
import os
import uuid
from datetime import datetime, timezone, timedelta

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import Optional


# ─── Data Models ─────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    token: str
    machine_id: str
    team: str

class SendRequest(BaseModel):
    token: str
    from_machine: str
    from_team: str
    to_team: str
    message: dict

class PollRequest(BaseModel):
    machine_id: str
    team: str

class AckRequest(BaseModel):
    token: str
    machine_id: str
    acked_ids: list[str]

class KeepaliveRequest(BaseModel):
    token: str
    machine_id: str
    team: str
    agents: Optional[dict[str, dict]] = None  # v3.6: folded agent roster

class HeartbeatRequest(BaseModel):
    token: str
    machine_id: str
    team: str
    agents: dict[str, dict]   # agent_name → { status_text: "..." } for v3.6


# ─── Application Setup ───────────────────────────────────────────────────────

app = FastAPI(title="CC2CC Relay Hub", version="1.0.0")

registrations: dict[str, dict] = {}        # key: f"{machine_id}:{team}"
message_queue: dict[str, list[dict]] = {}  # key: f"{machine_id}:{team}"
leased_messages: dict[str, dict] = {}      # key: lease_id
tokens: set[str] = set()

REGISTRATION_TTL = 30
LEASE_TTL = 30
MAX_QUEUED_PER_TEAM = 1000
MESSAGE_MAX_AGE_SECONDS = 86400  # 24h


def init_tokens():
    env_token = os.environ.get("CC2CC_RELAY_TOKEN")
    if env_token:
        tokens.add(env_token)


def _team_key(machine_id: str, team: str) -> str:
    return f"{machine_id}:{team}"


def _check_token(token: str):
    if token not in tokens:
        raise HTTPException(status_code=401, detail="Invalid token")


def _is_registration_active(reg: dict) -> bool:
    last_seen = datetime.fromisoformat(reg["last_seen"])
    age = (datetime.now(timezone.utc) - last_seen).total_seconds()
    return age < reg["ttl"]



# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.post("/api/register")
async def api_register(req: RegisterRequest):
    _check_token(req.token)
    key = _team_key(req.machine_id, req.team)
    registrations[key] = {
        "machine_id": req.machine_id,
        "team": req.team,
        "last_seen": datetime.now(timezone.utc).isoformat(),
        "ttl": REGISTRATION_TTL,
        "agents": {},
    }
    return {"status": "registered", "ttl_seconds": REGISTRATION_TTL}


@app.post("/api/send")
async def api_send(req: SendRequest):
    _check_token(req.token)

    # H3: Validate sender has an active registration
    sender_key = _team_key(req.from_machine, req.from_team)
    if sender_key not in registrations or not _is_registration_active(registrations[sender_key]):
        raise HTTPException(status_code=403, detail="Sender not registered or registration expired")

    # B4: Route by (machine_id, team) — find all machines registered for target team
    target_keys = []
    for key, reg in registrations.items():
        if reg["team"] == req.to_team and _is_registration_active(reg):
            target_keys.append(key)
    if not target_keys:
        raise HTTPException(status_code=404, detail=f"Team '{req.to_team}' has no active registrations")

    # B10: Generate safe file ID — do not trust sender-supplied id
    msg_id = f"relay-{uuid.uuid4()}"
    msg = {
        "id": msg_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "from_machine": req.from_machine,
        "from_team": req.from_team,
        "to_team": req.to_team,
        "message": req.message,
    }

    # B9: Stamp message creation for 24h expiry
    created = datetime.now(timezone.utc)

    # Enqueue for each target (machine_id,team) pair
    for key in target_keys:
        if key not in message_queue:
            message_queue[key] = []
        queue = message_queue[key]
        if len(queue) >= MAX_QUEUED_PER_TEAM:
            continue  # skip full queues instead of blocking send
        queue.append({
            "id": msg_id,
            "msg": msg,
            "created": created,
            "leased_to": None,
            "lease_expires": None,
        })

    return {"status": "accepted", "message_id": msg_id}


@app.post("/api/poll")
async def api_poll(req: PollRequest, request: Request):
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        _check_token(token)
    else:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    now = datetime.now(timezone.utc)

    online_teams = {}
    for key, reg in registrations.items():
        if _is_registration_active(reg):
            team = reg["team"]
            if team not in online_teams:
                online_teams[team] = {
                    "machine_id": reg["machine_id"],
                    "agents": reg.get("agents", {}),
                }

    # B4: Poll only own (machine_id, team) queue
    poll_key = _team_key(req.machine_id, req.team)
    team_queue = message_queue.get(poll_key, [])

    # B9: Remove expired messages (24h TTL) before processing
    team_queue[:] = [e for e in team_queue if (now - e["created"]).total_seconds() < MESSAGE_MAX_AGE_SECONDS]

    available_messages = []
    for entry in team_queue:
        if entry["leased_to"] and entry["lease_expires"]:
            expire_dt = datetime.fromisoformat(entry["lease_expires"])
            if expire_dt > now:
                continue
            # B7: Supersede old lease — remove it from leased_messages before re-leasing
            old_lease_id = entry.get("current_lease_id")
            if old_lease_id and old_lease_id in leased_messages:
                del leased_messages[old_lease_id]

        lease_id = f"lease-{uuid.uuid4()}"
        # B2: Use timedelta instead of replace()
        expires = now + timedelta(seconds=LEASE_TTL)

        entry["leased_to"] = req.machine_id
        entry["lease_expires"] = expires.isoformat()
        entry["current_lease_id"] = lease_id  # B7: Track current lease for superseding on re-lease

        leased_messages[lease_id] = {
            "key": poll_key,
            "queue_entry_id": entry["id"],
            "msg": entry["msg"],
            "expires": expires.isoformat(),
        }
        available_messages.append({**entry["msg"], "lease_id": lease_id})

    return {"messages": available_messages, "online_teams": online_teams}


@app.post("/api/ack")
async def api_ack(req: AckRequest):
    _check_token(req.token)
    deleted = 0
    for lease_id in req.acked_ids:
        if lease_id in leased_messages:
            lease_data = leased_messages.pop(lease_id)
            key = lease_data["key"]
            # B7: Ack by specific lease_id and queue_entry_id
            entry_id = lease_data["queue_entry_id"]
            if key in message_queue:
                message_queue[key] = [e for e in message_queue[key] if e["id"] != entry_id]
            deleted += 1
    return {"status": "ok", "deleted_count": deleted}


@app.post("/api/keepalive")
async def api_keepalive(req: KeepaliveRequest):
    _check_token(req.token)
    key = _team_key(req.machine_id, req.team)
    if key not in registrations:
        raise HTTPException(status_code=404, detail="Not registered")
    registrations[key]["last_seen"] = datetime.now(timezone.utc).isoformat()
    return {"status": "ok", "ttl_seconds": REGISTRATION_TTL}


@app.post("/api/heartbeat")
async def api_heartbeat(req: HeartbeatRequest):
    _check_token(req.token)
    key = _team_key(req.machine_id, req.team)
    if key not in registrations:
        raise HTTPException(status_code=404, detail="Not registered")
    registrations[key]["agents"] = req.agents
    registrations[key]["last_seen"] = datetime.now(timezone.utc).isoformat()
    return {"status": "ok"}


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "registrations": len(registrations),
        "queued_messages": sum(len(q) for q in message_queue.values()),
        "active_leases": len(leased_messages),
    }


# ─── Background Cleanup ──────────────────────────────────────────────────────

async def cleanup_expired():
    import asyncio
    while True:
        await asyncio.sleep(10)
        now = datetime.now(timezone.utc)

        # Expired registrations
        expired_keys = [k for k, r in registrations.items() if not _is_registration_active(r)]
        for key in expired_keys:
            del registrations[key]

        # Expired leases — return to queue
        expired_leases = [lid for lid, ld in leased_messages.items()
                          if datetime.fromisoformat(ld["expires"]) <= now]
        for lid in expired_leases:
            if lid in leased_messages:
                ld = leased_messages.pop(lid)
                key = ld["key"]
                entry_id = ld["queue_entry_id"]
                if key in message_queue:
                    for entry in message_queue[key]:
                        if entry["id"] == entry_id:
                            entry["leased_to"] = None
                            entry["lease_expires"] = None
                            break

        # B9: Remove messages older than 24h from queues
        stale_cutoff = now - timedelta(seconds=MESSAGE_MAX_AGE_SECONDS)
        for key in list(message_queue.keys()):
            message_queue[key] = [e for e in message_queue[key] if e["created"] > stale_cutoff]
            if not message_queue[key]:
                del message_queue[key]


@app.on_event("startup")
async def startup():
    import asyncio
    init_tokens()
    # H1: Refuse to start without any token configured
    if not tokens:
        raise RuntimeError(
            "No relay token configured. Set CC2CC_RELAY_TOKEN environment variable "
            "or pass --token on the command line."
        )
    asyncio.create_task(cleanup_expired())


@app.get("/")
async def root():
    return {"service": "CC2CC Relay Hub", "version": "1.0.0"}


# ─── Entry Point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="CC2CC Relay Hub")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--token", default=None, help="Auth token (overrides env)")
    args = parser.parse_args()
    if args.token:
        tokens.add(args.token)
    import uvicorn
    print(f"CC2CC Relay Hub starting on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
