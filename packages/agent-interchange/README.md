# @roo-code/agent-interchange

Read, brief and hand over coding-agent work **between Claude Code and Tumble Code**.

Both agents keep the conversation as Anthropic content blocks, so the message
layer is already common. What differs is the envelope, the metadata and the tool
vocabulary. This package normalizes both stores into one model and exposes them
over MCP, so either agent can pick up where the other stopped.

## What it reads

| store       | location                                             | notes                                                                                                                                 |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/projects/<slug>/<sessionId>.jsonl`        | `$CLAUDE_CONFIG_DIR` is honoured; subagent turns are kept separate                                                                    |
| Tumble Code | `<globalStorage>/qub-it.tumble-code/tasks/<taskId>/` | also finds `rooveterinaryinc.roo-cline`, remote servers, VSCodium, Cursor, Windsurf, and a `customStoragePath` set in `settings.json` |
| Plans       | workspace `ai_plans/`, `docs/plans/`, `.plans/`      | read-only; machine-global `~/.claude/plans/*.md` requires the explicit cross-workspace server opt-in                                  |
| Handoffs    | `~/.local/share/agent-interchange/handoffs/`         | override with `$AGENT_INTERCHANGE_DIR`                                                                                                |

Nothing is ever written into either agent's own store.

A handoff is `<id>.md` plus, while updates are in flight, a `<id>.md.updates/`
directory beside it. Independent processes never write the same file: each
update publishes one immutable operation into that directory, and the next
update folds them into the Markdown and removes the ones it absorbed. Copy or
back up the two together — a `.md` on its own can be missing the newest updates.
Leftover `.tmp` files are from writers that died mid-publish and are safe to
delete.

## The MCP server

Build and install once from the package directory. The installer copies the MCP
bundle to durable user data; registrations never point at this checkout:

```bash
pnpm install:mcp -- --tumble-config /absolute/globalStorage/settings/mcp_settings.json
```

Find Tumble's exact global config with **MCP Servers → Edit Global MCP**. The
installer requires that existing path rather than guessing among VS Code,
VSCodium, remote and custom-storage profiles. It atomically merges only the
`agent-interchange` entry into both that file and `~/.claude.json`, preserving
all other settings and servers. Override the latter with `--claude-config` when
needed.

Run the same install command after updates; it atomically replaces the durable
bundle and refreshes both registrations. To uninstall:

```bash
pnpm uninstall:mcp -- --tumble-config /absolute/globalStorage/settings/mcp_settings.json
```

### Claude Code

The installer registers it once, for every project. Manual equivalent:

```bash
claude mcp add --scope user agent-interchange -- node /absolute/durable/user-data/agent-interchange/mcp-server.mjs
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
			"args": ["/home/you/.local/share/agent-interchange/mcp-server.mjs"],
			"alwaysAllow": ["list_agent_sessions", "read_agent_session", "list_handoffs", "read_handoff"]
		}
	}
}
```

Use the installer's durable destination (by default the path above on Linux,
with your real home directory), or the absolute `--destination` override passed
at install time. Do not point this registration at `dist/` inside a checkout.

The extension also ships native commands that do not need the server:
**Tumble Code: Pick Up Agent Session…** and **Tumble Code: Hand Off Current Task…**.

### Tools

| tool                                                | for                                                       |
| --------------------------------------------------- | --------------------------------------------------------- |
| `list_agent_sessions`                               | what the other agent has been doing, newest first         |
| `read_agent_session`                                | `briefing` (default) or a paginated `transcript`          |
| `search_agent_sessions`                             | find a session by text in its conversation                |
| `list_agent_plans` / `read_agent_plan`              | workspace plans; global Claude plans only when privileged |
| `create_handoff`                                    | freeze a session into a document the other agent picks up |
| `list_handoffs` / `read_handoff` / `update_handoff` | the pick-up lifecycle                                     |

Workspace-scoped tools default to the directory the server was started in, which
is the workspace in both clients. Empty workspace arguments are rejected, and
known session/handoff ids from another workspace are hidden. Administrators who
deliberately need machine-wide access may start a separate server registration
with `AGENT_INTERCHANGE_ALLOW_CROSS_WORKSPACE=1`; only that server accepts
`workspace: ""` or exposes Claude Code's machine-global plan store. Direct plan
paths are checked against the same boundary. Do not auto-approve that privileged
registration.

## Why a briefing and not a replayed session

A briefing is derived from the transcript — files written, commands run, the
plan, the open questions, the outcome — so it does not depend on the previous
model having described its own work accurately. Replaying a session natively
into the other agent cannot be done faithfully: tool names differ, signed
`thinking` blocks are not portable, and `tool_use`/`tool_result` pairing breaks
across vocabularies. A half-valid session file is worse than an honest summary,
so the raw transcript is offered as a separate, paginated read instead.
