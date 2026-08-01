import * as fs from "node:fs"
import * as path from "node:path"

import { claudePlansDir } from "./locate.js"

/**
 * Plan documents, from wherever each agent leaves them.
 *
 * Claude Code writes plan-mode artifacts to `~/.claude/plans/*.md` under
 * generated names with no workspace attached. Those are available only to a
 * server explicitly started with cross-workspace access; ordinary servers see
 * workspace-contained plans only.
 * Tumble Code has no plan store of its own — in this repository plans are
 * committed under `ai_plans/`, which is where both agents actually look.
 */

export type PlanSource = "claude-code" | "workspace"

export interface PlanDoc {
	source: PlanSource
	title: string
	path: string
	updatedAt: number
	sizeBytes: number
}

/** Workspace-relative directories searched for plan documents, in order. */
const WORKSPACE_PLAN_DIRS = ["ai_plans", "docs/plans", ".plans"]

export interface PlanAccessOptions {
	cwd?: string
	allowClaudeGlobal?: boolean
}

export function listPlans(options: PlanAccessOptions & { query?: string; limit?: number } = {}): PlanDoc[] {
	const docs: PlanDoc[] = [
		...(options.allowClaudeGlobal === true ? claudePlans() : []),
		...workspacePlans(options.cwd),
	]

	const filtered = options.query
		? docs.filter((doc) => {
				const needle = options.query!.toLowerCase()
				return doc.title.toLowerCase().includes(needle) || doc.path.toLowerCase().includes(needle)
			})
		: docs

	filtered.sort((a, b) => b.updatedAt - a.updatedAt)

	return options.limit ? filtered.slice(0, options.limit) : filtered
}

/**
 * Read a plan by the absolute path a listing returned.
 *
 * The path is validated against the roots that produced it, so a caller cannot
 * turn this into a general file reader.
 */
export function readPlan(
	file: string,
	options: PlanAccessOptions = {},
): { doc: PlanDoc; markdown: string } | undefined {
	const resolved = path.resolve(file)
	const workspaceRoots = planDirsIn(options.cwd)
	const roots = [...(options.allowClaudeGlobal === true ? [claudePlansDir()] : []), ...workspaceRoots]

	if (!roots.some((root) => isInside(resolved, root))) {
		return undefined
	}

	let markdown: string

	try {
		markdown = fs.readFileSync(resolved, "utf8")
	} catch {
		return undefined
	}

	const doc = describe(
		resolved,
		options.allowClaudeGlobal === true && isInside(resolved, claudePlansDir()) ? "claude-code" : "workspace",
	)

	return doc ? { doc, markdown } : undefined
}

export function renderPlanList(docs: PlanDoc[]): string {
	if (docs.length === 0) {
		return "No plan documents found."
	}

	const lines = ["| source | updated | title | path |", "| --- | --- | --- | --- |"]

	for (const doc of docs) {
		lines.push(
			`| ${doc.source} | ${new Date(doc.updatedAt).toISOString().slice(0, 10)} | ${doc.title.replace(/\|/g, "\\|")} | \`${doc.path}\` |`,
		)
	}

	return lines.join("\n")
}

function claudePlans(): PlanDoc[] {
	return markdownFilesIn(claudePlansDir())
		.map((file) => describe(file, "claude-code"))
		.filter((doc): doc is PlanDoc => doc !== undefined)
}

function workspacePlans(cwd: string | undefined): PlanDoc[] {
	return planDirsIn(cwd)
		.flatMap((dir) => markdownFilesIn(dir))
		.map((file) => describe(file, "workspace"))
		.filter((doc): doc is PlanDoc => doc !== undefined)
}

function planDirsIn(cwd: string | undefined): string[] {
	if (!cwd) {
		return []
	}

	return WORKSPACE_PLAN_DIRS.map((dir) => path.join(cwd, dir)).filter((dir) => {
		try {
			return fs.statSync(dir).isDirectory()
		} catch {
			return false
		}
	})
}

function markdownFilesIn(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => path.join(dir, entry.name))
	} catch {
		return []
	}
}

/** Title = the first `#` heading, falling back to the file name. */
function describe(file: string, source: PlanSource): PlanDoc | undefined {
	let stat: fs.Stats

	try {
		stat = fs.statSync(file)
	} catch {
		return undefined
	}

	return {
		source,
		title: firstHeading(file) ?? path.basename(file, ".md"),
		path: file,
		updatedAt: stat.mtimeMs,
		sizeBytes: stat.size,
	}
}

function firstHeading(file: string): string | undefined {
	let head: string

	try {
		const fd = fs.openSync(file, "r")

		try {
			const buffer = Buffer.alloc(Math.min(4096, fs.fstatSync(fd).size))
			fs.readSync(fd, buffer, 0, buffer.length, 0)
			head = buffer.toString("utf8")
		} finally {
			fs.closeSync(fd)
		}
	} catch {
		return undefined
	}

	for (const line of head.split("\n")) {
		const match = /^#\s+(.+?)\s*$/.exec(line)

		if (match) {
			return match[1]
		}
	}

	return undefined
}

function isInside(candidate: string, root: string): boolean {
	const normalizedRoot = path.resolve(root) + path.sep
	return path.resolve(candidate).startsWith(normalizedRoot)
}
