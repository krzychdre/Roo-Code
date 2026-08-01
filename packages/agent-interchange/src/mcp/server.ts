import * as path from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { renderBriefing, renderSessionList } from "../briefing.js"
import {
	createHandoff,
	listHandoffs,
	readHandoff,
	renderHandoffList,
	updateHandoff,
	type HandoffStatus,
} from "../handoffs.js"
import { listPlans, readPlan, renderPlanList } from "../plans.js"
import { renderSearchHits, searchSessions } from "../search.js"
import { renderTranscript } from "../transcript.js"
import { listSessions, readSession } from "../index.js"
import type { AgentKind } from "../types.js"

/**
 * The MCP surface both agents talk to.
 *
 * Tool descriptions are written for the weakest model that will ever call them:
 * every parameter is optional where a sane default exists, `workspace` defaults
 * to the directory the server was started in, and each tool says in one line
 * when to reach for it. Output is markdown, not JSON, because both clients feed
 * it straight into a context window.
 */

const agentEnum = z.enum(["claude-code", "tumble-code"])

const VERSION = "0.0.1"

export interface InterchangeServerOptions {
	/** Deliberate administrator opt-in; ordinary tool calls cannot enable this. */
	allowCrossWorkspace?: boolean
}

export function createInterchangeServer(
	defaultCwd: string = process.cwd(),
	options: InterchangeServerOptions = {},
): McpServer {
	const allowCrossWorkspace = options.allowCrossWorkspace === true
	const server = new McpServer(
		{ name: "agent-interchange", version: VERSION },
		{
			instructions: [
				"Read and hand over coding-agent work between Claude Code and Tumble Code.",
				"",
				"Typical flow when the user says 'continue what the other agent was doing':",
				"1. `list_agent_sessions` — find the session (defaults to this workspace, newest first).",
				"2. `read_agent_session` — the default `briefing` format is a summary of the request,",
				"   the plan, the files changed, the commands run and the open questions.",
				'3. `read_agent_session` with `format: "transcript"` only when the briefing is not enough;',
				"   it is paginated, so pass the `offset` it reports back to you.",
				"",
				"When handing work over, call `create_handoff` with concrete `next_steps`, and have the",
				'other side call `update_handoff` with `status: "picked-up"` and then `"done"`.',
			].join("\n"),
		},
	)

	const workspace = z
		.string()
		.min(allowCrossWorkspace ? 0 : 1, "workspace must not be empty")
		.refine(
			(value) => allowCrossWorkspace || sameWorkspace(value, defaultCwd),
			"workspace must match the workspace this server was started in",
		)
		.optional()
		.describe(
			allowCrossWorkspace
				? `Absolute workspace path. Defaults to ${defaultCwd}. This server was explicitly started with cross-workspace access; pass "" for every workspace.`
				: `Absolute workspace path. Defaults to ${defaultCwd}. Empty values are rejected.`,
		)

	const resolveCwd = (value: string | undefined): string | undefined =>
		allowCrossWorkspace && value === "" ? undefined : (value ?? defaultCwd)

	const sessionInWorkspace = (session: { cwd?: string }, cwd: string | undefined): boolean =>
		cwd === undefined || sameWorkspace(session.cwd, cwd)

	server.registerTool(
		"list_agent_sessions",
		{
			title: "List agent sessions",
			description:
				"List coding-agent sessions from both Claude Code and Tumble Code, newest first. Use this first when the user refers to earlier work done by the other agent.",
			inputSchema: {
				workspace,
				agent: agentEnum.optional().describe("Only sessions from this agent. Omit for both."),
				query: z.string().optional().describe("Case-insensitive substring the title must contain."),
				limit: z.number().int().min(1).max(200).optional().describe("How many to return. Default 25."),
			},
		},
		async ({ workspace: cwd, agent, query, limit }) => {
			const summaries = listSessions({
				cwd: resolveCwd(cwd),
				agent: agent as AgentKind | undefined,
				query,
				limit: limit ?? 25,
			})

			return text(renderSessionList(summaries))
		},
	)

	server.registerTool(
		"read_agent_session",
		{
			title: "Read an agent session",
			description:
				"Read one session by id. The default `briefing` format gives the request, the plan, the files changed, the commands run, the open questions and the outcome — that is normally all you need to take the task over. Use `transcript` only for the raw conversation; it is paginated.",
			inputSchema: {
				session_id: z.string().describe("The id from list_agent_sessions."),
				workspace,
				format: z
					.enum(["briefing", "transcript"])
					.optional()
					.describe("`briefing` (default) or `transcript` for the raw messages."),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe("Transcript only: first message to show. Default 0."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe("Transcript only: how many messages. Default 30."),
				include_thinking: z
					.boolean()
					.optional()
					.describe("Transcript only: include the model's reasoning blocks. Default false."),
				subagents: z
					.boolean()
					.optional()
					.describe("Transcript only: show the subagent turns instead of the main thread. Default false."),
			},
		},
		async ({ session_id, workspace: cwd, format, offset, limit, include_thinking, subagents }) => {
			const session = await readSession(session_id)
			const allowedCwd = resolveCwd(cwd)

			if (!session || !sessionInWorkspace(session, allowedCwd)) {
				return text(`No session with id \`${session_id}\`. Call list_agent_sessions to see what exists.`)
			}

			if (format === "transcript") {
				return text(
					renderTranscript(session, {
						offset,
						limit,
						includeThinking: include_thinking,
						sidechains: subagents,
					}).markdown,
				)
			}

			return text(renderBriefing(session))
		},
	)

	server.registerTool(
		"search_agent_sessions",
		{
			title: "Search agent sessions",
			description:
				"Find sessions whose conversation contains some text — an error message, a file name, a decision. Searches both agents' stores and returns matching snippets.",
			inputSchema: {
				query: z.string().min(2).describe("Text to look for."),
				workspace,
				agent: agentEnum.optional().describe("Only search this agent's sessions."),
				limit: z.number().int().min(1).max(50).optional().describe("How many sessions to return. Default 10."),
			},
		},
		async ({ query, workspace: cwd, agent, limit }) => {
			const hits = await searchSessions({
				query,
				cwd: resolveCwd(cwd),
				agent: agent as AgentKind | undefined,
				limit: limit ?? 10,
			})

			return text(renderSearchHits(hits))
		},
	)

	server.registerTool(
		"list_agent_plans",
		{
			title: "List plan documents",
			description:
				"List plan documents from both worlds: Claude Code's plan-mode artifacts in ~/.claude/plans and the plans committed in the workspace (ai_plans/, docs/plans/).",
			inputSchema: {
				workspace,
				query: z.string().optional().describe("Substring the title or path must contain."),
				limit: z.number().int().min(1).max(100).optional().describe("How many to return. Default 30."),
			},
		},
		async ({ workspace: cwd, query, limit }) =>
			text(renderPlanList(listPlans({ cwd: resolveCwd(cwd), query, limit: limit ?? 30 }))),
	)

	server.registerTool(
		"read_agent_plan",
		{
			title: "Read a plan document",
			description: "Read one plan document. Pass the `path` exactly as list_agent_plans printed it.",
			inputSchema: {
				path: z.string().describe("Absolute path from list_agent_plans."),
				workspace,
			},
		},
		async ({ path: file, workspace: cwd }) => {
			const plan = readPlan(file, resolveCwd(cwd))

			return text(
				plan
					? plan.markdown
					: `\`${file}\` is not a plan document this tool may read. Use list_agent_plans and copy a path from it.`,
			)
		},
	)

	server.registerTool(
		"create_handoff",
		{
			title: "Hand a task over to the other agent",
			description:
				"Freeze a session into a handoff document the other agent can pick up: the briefing plus the next steps you name. Use this when the user wants work continued elsewhere.",
			inputSchema: {
				session_id: z.string().describe("Session being handed over, from list_agent_sessions."),
				workspace,
				to: agentEnum.describe("Which agent should pick this up."),
				next_steps: z
					.array(z.string())
					.optional()
					.describe("Concrete steps for the next agent, one per entry. Strongly recommended."),
				notes: z
					.string()
					.optional()
					.describe("Anything the transcript does not show: constraints, traps, decisions already made."),
			},
		},
		async ({ session_id, workspace: cwd, to, next_steps, notes }) => {
			const session = await readSession(session_id)
			const allowedCwd = resolveCwd(cwd)

			if (!session || !sessionInWorkspace(session, allowedCwd)) {
				return text(`No session with id \`${session_id}\`.`)
			}

			const handoff = createHandoff({ session, to: to as AgentKind, nextSteps: next_steps, notes })

			return text(
				[
					`Handoff \`${handoff.id}\` created for ${to}.`,
					`Stored at \`${handoff.path}\`.`,
					"",
					"The other agent will find it with list_handoffs.",
				].join("\n"),
			)
		},
	)

	server.registerTool(
		"list_handoffs",
		{
			title: "List handoffs",
			description:
				"List tasks the other agent handed over. Check this when the user says something was 'left for you' or 'started in the other agent'.",
			inputSchema: {
				workspace,
				status: z
					.enum(["open", "picked-up", "done", "abandoned"])
					.optional()
					.describe("Filter by lifecycle state. Omit for all."),
				to: agentEnum.optional().describe("Only handoffs addressed to this agent."),
				limit: z.number().int().min(1).max(100).optional().describe("How many to return. Default 25."),
			},
		},
		async ({ workspace: cwd, status, to, limit }) =>
			text(
				renderHandoffList(
					listHandoffs({
						cwd: resolveCwd(cwd),
						status: status as HandoffStatus | undefined,
						to: to as AgentKind | undefined,
						limit: limit ?? 25,
					}),
				),
			),
	)

	server.registerTool(
		"read_handoff",
		{
			title: "Read a handoff",
			description: "Read the full handoff document: briefing, next steps, notes and log.",
			inputSchema: {
				handoff_id: z.string().describe("The id from list_handoffs."),
				workspace,
			},
		},
		async ({ handoff_id, workspace: cwd }) => {
			const handoff = readHandoff(handoff_id)
			const allowedCwd = resolveCwd(cwd)

			return text(
				handoff && sessionInWorkspace(handoff, allowedCwd)
					? handoff.markdown
					: `No handoff with id \`${handoff_id}\`.`,
			)
		},
	)

	server.registerTool(
		"update_handoff",
		{
			title: "Update a handoff",
			description:
				"Record progress on a handoff: `picked-up` when you start it, `done` when it is finished, `abandoned` if it is dropped. Add a `note` to explain.",
			inputSchema: {
				handoff_id: z.string().describe("The id from list_handoffs."),
				workspace,
				status: z.enum(["open", "picked-up", "done", "abandoned"]).optional().describe("New lifecycle state."),
				note: z.string().optional().describe("One line for the log."),
				picked_up_by: agentEnum.optional().describe("Which agent took it."),
				picked_up_session_id: z.string().optional().describe("The session that is continuing the work."),
			},
		},
		async ({ handoff_id, workspace: cwd, status, note, picked_up_by, picked_up_session_id }) => {
			const allowedCwd = resolveCwd(cwd)
			const existing = readHandoff(handoff_id)
			const handoff =
				existing && sessionInWorkspace(existing, allowedCwd)
					? updateHandoff(handoff_id, {
							status: status as HandoffStatus | undefined,
							note,
							pickedUpBy: picked_up_by as AgentKind | undefined,
							pickedUpSessionId: picked_up_session_id,
						})
					: undefined

			return text(
				handoff
					? `Handoff \`${handoff.id}\` is now ${handoff.status}.`
					: `No handoff with id \`${handoff_id}\`.`,
			)
		},
	)

	return server
}

function text(markdown: string) {
	return { content: [{ type: "text" as const, text: markdown }] }
}

function sameWorkspace(recorded: string | undefined, allowed: string): boolean {
	return recorded !== undefined && path.resolve(recorded) === path.resolve(allowed)
}
