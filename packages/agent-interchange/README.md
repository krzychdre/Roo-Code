# @roo-code/agent-interchange

Read, brief and hand over coding-agent work **between Claude Code and Tumble Code**.

Both agents keep the conversation as Anthropic content blocks, so the message
layer is already common. What differs is the envelope, the metadata and the tool
vocabulary. This package normalizes both stores into one model and exposes them
over MCP, so either agent can pick up where the other stopped.

## What it reads

| store       | location                                               | notes                                                                                                                                 |
| ----------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl`          | `$CLAUDE_CONFIG_DIR` is honoured; subagent turns are kept separate                                                                    |
| Tumble Code | `<globalStorage>/qub-it.tumble-code/tasks/<taskId>/`   | also finds `rooveterinaryinc.roo-cline`, remote servers, VSCodium, Cursor, Windsurf, and a `customStoragePath` set in `settings.json` |
| Plans       | `~/.claude/plans/*.md` and the workspace's `ai_plans/` | read-only                                                                                                                             |
| Handoffs    | `~/.local/share/agent-interchange/handoffs/`           | override with `$AGENT_INTERCHANGE_DIR`                                                                                                |

Nothing is ever written into either agent's own store.

## The MCP server

```bash
pnpm --filter @roo-code/agent-interchange build   # produces dist/mcp-server.mjs
```

### Claude Code

Register it once, for every project:

```bash
claude mcp add --scope user agent-interchange -- node /absolute/path/to/Roo-Code/packages/agent-interchange/dist/mcp-server.mjs
```

The path has to be absolute. A project-scoped `.mcp.json` with a relative path
would only resolve when Claude Code is started from the repository root, and it
collides with the user-scope entry when both exist.

### Tumble Code

Add the same command to the MCP settings (`MCP Servers → Edit Global MCP`):

```json
{
	"mcpServers": {
		"agent-interchange": {
			"command": "node",
			"args": ["/absolute/path/to/Roo-Code/packages/agent-interchange/dist/mcp-server.mjs"],
			"alwaysAllow": ["list_agent_sessions", "read_agent_session", "list_handoffs", "read_handoff"]
		}
	}
}
```

The extension also ships native commands that do not need the server:
**Tumble Code: Pick Up Agent Session…** and **Tumble Code: Hand Off Current Task…**.

### Tools

| tool                                                | for                                                       |
| --------------------------------------------------- | --------------------------------------------------------- |
| `list_agent_sessions`                               | what the other agent has been doing, newest first         |
| `read_agent_session`                                | `briefing` (default) or a paginated `transcript`          |
| `search_agent_sessions`                             | find a session by text in its conversation                |
| `list_agent_plans` / `read_agent_plan`              | plan documents from both worlds                           |
| `create_handoff`                                    | freeze a session into a document the other agent picks up |
| `list_handoffs` / `read_handoff` / `update_handoff` | the pick-up lifecycle                                     |

Workspace-scoped tools default to the directory the server was started in, which
is the workspace in both clients. Empty workspace arguments are rejected, and
known session/handoff ids from another workspace are hidden. Administrators who
deliberately need machine-wide access may start a separate server registration
with `AGENT_INTERCHANGE_ALLOW_CROSS_WORKSPACE=1`; only that server accepts
`workspace: ""`. Do not auto-approve that privileged registration.

## Why a briefing and not a replayed session

A briefing is derived from the transcript — files written, commands run, the
plan, the open questions, the outcome — so it does not depend on the previous
model having described its own work accurately. Replaying a session natively
into the other agent cannot be done faithfully: tool names differ, signed
`thinking` blocks are not portable, and `tool_use`/`tool_result` pairing breaks
across vocabularies. A half-valid session file is worse than an honest summary,
so the raw transcript is offered as a separate, paginated read instead.
