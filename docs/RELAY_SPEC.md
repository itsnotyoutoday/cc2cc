# CC2CC Global Relay Specification v0.1

## Overview
The CC2CC Global Relay enables cross-network messaging between Claude Code instances that are not on the same local filesystem. It acts as a "mailbox in the cloud" (Relay Hub) while maintaining the local file-based semantics that the CC2CC MCP server expects.

## Architecture

```
Agent Alpha (Machine A)        Relay Hub (Public)        Agent Beta (Machine B)
       |                            |                            |
[Local Bridge A] <----HTTPS/WS----> [Hub] <----HTTPS/WS----> [Local Bridge B]
       |                            |                            |
 [~/.cc2cc/...]               [Routing Table]               [~/.cc2cc/...]
```

### Components
1. **Relay Hub**: A public-facing service that handles WebSocket connections and long-polling requests.
2. **Bridge Daemon**: A local background process (or part of the MCP server) that syncs local `inbox` files to the Hub and pulls remote messages from the Hub to local `inbox` directories.

## Protocol: Hybrid Push/Pull

To handle NAT and varying connectivity:
- **Push (WebSocket)**: Preferred for real-time delivery when the Bridge Daemon can maintain a persistent connection.
- **Pull (Long-polling)**: Fallback for restrictive networks.

### Message Routing
The Hub routes messages based on a `relay_id` which is a tuple of `(room_id, recipient_agent_id)`.

## Zero-Knowledge Security
- **End-to-End Integrity**: All messages are signed locally using the shared `secret.key` (HMAC-SHA256).
- **Encryption**: Future versions should implement AES-GCM encryption. Currently, the Hub sees the metadata and the signed payload.
- **Hub Responsibility**: The Hub *must not* modify message content. Modification will break the HMAC signature, causing the recipient to reject the message.

## Directory Structure Extension (v1.2)
To support rooms and relays, the local bridge directory is extended:

```
~/.cc2cc/
├── relay.json                # Relay Hub configuration (URL, Token)
├── rooms/
│   └── {room_id}/            # Isolated conversation space
│       ├── to-{agent}/
│       │   ├── inbox/        # Files here are picked up by Bridge Daemon to upload
│       │   └── done/
│       └── status/           # Virtual heartbeats for remote agents
```

## Virtual Heartbeats
The Bridge Daemon is responsible for:
1. Fetching the status of remote agents from the Hub.
2. Writing `{agent}-heartbeat.json` files to the local `rooms/{room_id}/status/` directory.
3. This tricks the local MCP server into thinking the remote agent is "online" and available for messaging.
