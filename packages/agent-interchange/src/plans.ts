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
	/** Verify that the descriptor really is the in-root file the path named. */
	requireOpenedPathVerification?: boolean
	/**
	 * Test seam: `portable` runs the cross-platform check even where `/proc` is
	 * available, so the path macOS and Windows take is exercised on Linux too.
	 */
	containment?: "auto" | "portable"
}

interface PlanRoot {
	path: string
	realPath: string
	source: PlanSource
}

export function listPlans(options: PlanAccessOptions & { query?: string; limit?: number } = {}): PlanDoc[] {
	const docs: PlanDoc[] = [
		...(options.allowClaudeGlobal === true ? claudePlans() : []),
		...workspacePlans(options.cwd, options.requireOpenedPathVerification === true, options.containment),
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
	const roots = planRoots(options)
	const root = roots.find((candidate) => isWithin(resolved, candidate.path))

	if (!root) {
		return undefined
	}

	const opened = openContainedPlan(
		resolved,
		root,
		options.requireOpenedPathVerification === true,
		options.containment,
	)

	if (!opened) {
		return undefined
	}

	try {
		const markdown = fs.readFileSync(opened.fd, "utf8")
		const doc = describeOpenPlan(resolved, root.source, opened.fd, markdown.slice(0, 4096))

		return { doc, markdown }
	} catch {
		return undefined
	} finally {
		fs.closeSync(opened.fd)
	}
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
	const root = resolvePlanRoot(claudePlansDir(), "claude-code")

	return (root ? markdownFilesIn(root) : [])
		.map((file) => describe(file, root!))
		.filter((doc): doc is PlanDoc => doc !== undefined)
}

function workspacePlans(
	cwd: string | undefined,
	requireOpenedPathVerification: boolean,
	containment: "auto" | "portable" = "auto",
): PlanDoc[] {
	return workspacePlanRoots(cwd)
		.flatMap((root) => markdownFilesIn(root).map((file) => ({ file, root })))
		.map(({ file, root }) => describe(file, root, requireOpenedPathVerification, containment))
		.filter((doc): doc is PlanDoc => doc !== undefined)
}

function planRoots(options: PlanAccessOptions): PlanRoot[] {
	return [
		...(options.allowClaudeGlobal === true
			? [resolvePlanRoot(claudePlansDir(), "claude-code")].filter((root): root is PlanRoot => root !== undefined)
			: []),
		...workspacePlanRoots(options.cwd),
	]
}

function workspacePlanRoots(cwd: string | undefined): PlanRoot[] {
	if (!cwd) {
		return []
	}

	let workspaceRealPath: string

	try {
		workspaceRealPath = fs.realpathSync(cwd)
	} catch {
		return []
	}

	return WORKSPACE_PLAN_DIRS.map((dir) => resolvePlanRoot(path.join(cwd, dir), "workspace"))
		.filter((root): root is PlanRoot => root !== undefined)
		.filter((root) => isWithin(root.realPath, workspaceRealPath))
}

function resolvePlanRoot(dir: string, source: PlanSource): PlanRoot | undefined {
	try {
		const realPath = fs.realpathSync(dir)

		return fs.statSync(realPath).isDirectory() ? { path: path.resolve(dir), realPath, source } : undefined
	} catch {
		return undefined
	}
}

function markdownFilesIn(root: PlanRoot): string[] {
	try {
		return fs
			.readdirSync(root.realPath, { withFileTypes: true })
			.filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
			.map((entry) => path.join(root.path, entry.name))
	} catch {
		return []
	}
}

/** Title = the first `#` heading, falling back to the file name. */
function describe(
	file: string,
	root: PlanRoot,
	requireOpenedPathVerification = false,
	containment: "auto" | "portable" = "auto",
): PlanDoc | undefined {
	const opened = openContainedPlan(file, root, requireOpenedPathVerification, containment)

	if (!opened) {
		return undefined
	}

	try {
		const stat = fs.fstatSync(opened.fd)
		const buffer = Buffer.alloc(Math.min(4096, stat.size))
		fs.readSync(opened.fd, buffer, 0, buffer.length, 0)

		return describeOpenPlan(file, root.source, opened.fd, buffer.toString("utf8"))
	} catch {
		return undefined
	} finally {
		fs.closeSync(opened.fd)
	}
}

function describeOpenPlan(file: string, source: PlanSource, fd: number, head: string): PlanDoc {
	const stat = fs.fstatSync(fd)

	return {
		source,
		title: firstHeading(head) ?? path.basename(file, ".md"),
		path: file,
		updatedAt: stat.mtimeMs,
		sizeBytes: stat.size,
	}
}

function openContainedPlan(
	file: string,
	root: PlanRoot,
	requireOpenedPathVerification: boolean,
	containment: "auto" | "portable" = "auto",
): { fd: number } | undefined {
	let realFile: string
	try {
		realFile = fs.realpathSync(file)
	} catch {
		return undefined
	}

	if (!isWithin(realFile, root.realPath)) {
		return undefined
	}

	let fd: number

	try {
		// O_NOFOLLOW does not exist on Windows; the verification below is what
		// carries the guarantee there.
		fd = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
	} catch {
		return undefined
	}

	try {
		const opened = fs.fstatSync(fd)

		if (!opened.isFile()) {
			fs.closeSync(fd)
			return undefined
		}

		if (requireOpenedPathVerification && !openedFileIsContained(fd, realFile, root, opened, containment)) {
			fs.closeSync(fd)
			return undefined
		}

		return { fd }
	} catch {
		fs.closeSync(fd)
		return undefined
	}
}

/**
 * Is the descriptor we hold the in-root file the path named?
 *
 * `realpath` resolving inside the root is not enough on its own: a component
 * could be swapped for a symlink between resolving it and opening it. This runs
 * after the open, so a swap is caught either way — left in place it is seen as a
 * link, and reverted it leaves the descriptor pointing at a different object
 * than the path now holds.
 */
function openedFileIsContained(
	fd: number,
	realFile: string,
	root: PlanRoot,
	opened: fs.Stats,
	containment: "auto" | "portable",
): boolean {
	if (containment === "auto" && process.platform === "linux") {
		// Linux names the object behind the descriptor directly, which settles it
		// without walking anything.
		try {
			return isWithin(fs.realpathSync(`/proc/self/fd/${fd}`), root.realPath)
		} catch {
			return false
		}
	}

	return pathHasNoSymlink(realFile, root.realPath) && pathNamesOpenedFile(realFile, opened)
}

/** No component between the root and the file is a symlink, root included. */
function pathHasNoSymlink(file: string, root: string): boolean {
	let current = root

	try {
		if (fs.lstatSync(current).isSymbolicLink()) {
			return false
		}

		for (const segment of path.relative(root, file).split(path.sep)) {
			current = path.join(current, segment)

			if (fs.lstatSync(current).isSymbolicLink()) {
				return false
			}
		}
	} catch {
		return false
	}

	return true
}

/**
 * The file at that path is the object we opened.
 *
 * Where a filesystem reports no inode identity — some Windows volumes leave
 * `ino` and `dev` at zero — this degrades to the symlink walk above, which still
 * refuses a planted link and leaves only the race window open.
 */
function pathNamesOpenedFile(file: string, opened: fs.Stats): boolean {
	try {
		const onPath = fs.lstatSync(file)

		return onPath.ino === opened.ino && onPath.dev === opened.dev
	} catch {
		return false
	}
}

function firstHeading(head: string): string | undefined {
	for (const line of head.split("\n")) {
		const match = /^#\s+(.+?)\s*$/.exec(line)

		if (match) {
			return match[1]
		}
	}

	return undefined
}

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
