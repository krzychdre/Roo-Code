import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Fixture builders that write the two stores exactly as the real tools do —
 * same file names, same record shapes — so a reader test fails when the reader
 * drifts, not when a hand-written mock does.
 */

export function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `agent-interchange-${prefix}-`))
}

export interface ClaudeSessionSpec {
	id: string
	cwd: string
	gitBranch?: string
	aiTitle?: string
	/** Written verbatim after the well-formed records, to simulate a live write. */
	truncatedTail?: boolean
	records?: unknown[]
}

/** Lay out `<root>/projects/<slug>/<id>.jsonl` the way Claude Code does. */
export function writeClaudeSession(configDir: string, spec: ClaudeSessionSpec): string {
	const slug = spec.cwd.replace(/[^a-zA-Z0-9]/g, "-")
	const dir = path.join(configDir, "projects", slug)

	fs.mkdirSync(dir, { recursive: true })

	const file = path.join(dir, `${spec.id}.jsonl`)
	const base = {
		cwd: spec.cwd,
		gitBranch: spec.gitBranch ?? "main",
		sessionId: spec.id,
		version: "2.1.220",
		userType: "external",
		isSidechain: false,
	}

	const records: unknown[] = spec.records ?? [
		{ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-31T10:00:00.000Z", sessionId: spec.id },
		{
			...base,
			type: "user",
			uuid: "u1",
			parentUuid: null,
			timestamp: "2026-07-31T10:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "Fix the flaky test" }] },
		},
		{
			...base,
			type: "assistant",
			uuid: "a1",
			parentUuid: "u1",
			timestamp: "2026-07-31T10:00:02.000Z",
			message: {
				role: "assistant",
				model: "claude-opus-5",
				content: [
					{ type: "thinking", thinking: "considering the retry" },
					{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "src/app.ts" } },
				],
			},
		},
		{
			...base,
			type: "user",
			uuid: "u2",
			parentUuid: "a1",
			timestamp: "2026-07-31T10:00:03.000Z",
			toolUseResult: { ok: true },
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] },
		},
		{
			...base,
			type: "assistant",
			uuid: "a2",
			parentUuid: "u2",
			isSidechain: true,
			timestamp: "2026-07-31T10:00:04.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "subagent output" }] },
		},
		...(spec.aiTitle ? [{ type: "ai-title", sessionId: spec.id, aiTitle: spec.aiTitle }] : []),
	]

	let body = records.map((record) => JSON.stringify(record)).join("\n") + "\n"

	if (spec.truncatedTail) {
		body += '{"type":"assistant","uuid":"a3","message":{"role":"assis'
	}

	fs.writeFileSync(file, body, "utf8")

	return file
}

export interface TumbleTaskSpec {
	id: string
	workspace?: string
	task?: string
	mode?: string
	ts?: number
	/** Omit `history_item.json`, as pre-2025 task directories do. */
	withoutHistoryItem?: boolean
	apiMessages?: unknown[]
	uiMessages?: unknown[]
}

/** Lay out `<root>/tasks/<id>/` the way the extension does. */
export function writeTumbleTask(storageDir: string, spec: TumbleTaskSpec): string {
	const dir = path.join(storageDir, "tasks", spec.id)

	fs.mkdirSync(dir, { recursive: true })

	const ts = spec.ts ?? Date.parse("2026-07-31T11:00:00.000Z")

	const apiMessages = spec.apiMessages ?? [
		{ role: "user", ts, content: [{ type: "text", text: `<task>\n${spec.task ?? "Add a feature"}\n</task>` }] },
		{
			role: "assistant",
			ts: ts + 1000,
			content: [
				{ type: "reasoning", text: "planning" },
				{ type: "tool_use", id: "c1", name: "apply_diff", input: { path: "src/feature.ts" } },
			],
		},
		{ role: "user", ts: ts + 2000, content: [{ type: "tool_result", tool_use_id: "c1", content: "applied" }] },
	]

	fs.writeFileSync(path.join(dir, "api_conversation_history.json"), JSON.stringify(apiMessages), "utf8")

	fs.writeFileSync(
		path.join(dir, "ui_messages.json"),
		JSON.stringify(spec.uiMessages ?? [{ ts, type: "say", say: "text", text: spec.task ?? "Add a feature" }]),
		"utf8",
	)

	if (!spec.withoutHistoryItem) {
		fs.writeFileSync(
			path.join(dir, "history_item.json"),
			JSON.stringify({
				id: spec.id,
				number: 1,
				ts: ts + 2000,
				task: spec.task ?? "Add a feature",
				tokensIn: 100,
				tokensOut: 20,
				totalCost: 0.01,
				workspace: spec.workspace ?? "/tmp/workspace",
				mode: spec.mode ?? "code",
				apiConfigName: "GLM-5.2",
				status: "completed",
			}),
			"utf8",
		)
	}

	return dir
}
