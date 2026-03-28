# CC2CC — Install via Prompt

Copy the prompt below and paste it into any Claude Code session. Claude will install and configure everything automatically.

## Install Prompt

```
Install cc2cc — a file-based agent-to-agent messaging system that lets multiple Claude Code sessions communicate with each other on the same machine.

Steps:

1. Clone the repo:
   git clone https://github.com/non4me/cc2cc.git ~/.cc2cc/repo

2. Install MCP server dependencies:
   cd ~/.cc2cc/repo/channel && npm install

3. Copy server files to bridge directory:
   cp ~/.cc2cc/repo/channel/server.mjs ~/.cc2cc/server.mjs
   cp ~/.cc2cc/repo/channel/names.mjs ~/.cc2cc/names.mjs
   cp ~/.cc2cc/repo/channel/package.json ~/.cc2cc/package.json
   cp -r ~/.cc2cc/repo/channel/node_modules ~/.cc2cc/node_modules

4. Create status directory:
   mkdir -p ~/.cc2cc/status

5. Add MCP server config — add this to the mcpServers section of ~/.claude.json (create if needed):
   "cc2cc": {
     "command": "node",
     "args": ["~/.cc2cc/server.mjs"],
     "env": { "CC2CC_BRIDGE_DIR": "~/.cc2cc" }
   }

6. Verify: run "node ~/.cc2cc/server.mjs" briefly to check it starts without errors (it will exit since there's no MCP transport — that's fine).

After installation, restart Claude Code with:
   claude --dangerously-load-development-channels server:cc2cc

Each session auto-registers with a unique name. Open two terminals to test — agents discover each other automatically.
```

## Uninstall

```
Remove cc2cc: delete ~/.cc2cc directory and remove the "cc2cc" entry from mcpServers in ~/.claude.json.
```
