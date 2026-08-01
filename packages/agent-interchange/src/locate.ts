import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Where each agent keeps its sessions, and how a workspace path maps onto a
 * directory name in those stores.
 *
 * Nothing here is documented by either tool, so every rule below was derived
 * from the real directories on disk and every lookup verifies itself against
 * the data rather than trusting the name.
 */

/** Extension ids that write a Tumble/Roo-shaped task store. Order = preference. */
const EXTENSION_IDS = ["qub-it.tumble-code", "rooveterinaryinc.roo-cline"]

/** VS Code-family user-data directory names, relative to the platform root. */
const VSCODE_APP_DIRS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"]

function homeDir(): string {
	return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

/** `~/.claude`, or `$CLAUDE_CONFIG_DIR` when the user relocated it. */
export function claudeConfigDir(): string {
	const override = process.env.CLAUDE_CONFIG_DIR?.trim()
	return override ? override : path.join(homeDir(), ".claude")
}

export function claudeProjectsDir(): string {
	return path.join(claudeConfigDir(), "projects")
}

export function claudePlansDir(): string {
	return path.join(claudeConfigDir(), "plans")
}

/**
 * Claude Code's project-directory name for a workspace: every non-alphanumeric
 * character becomes `-`.
 *
 * Verified against the real store — `/home/u/Downloads/vpn_jurasz` →
 * `-home-u-Downloads-vpn-jurasz`, `…/jurasz.ai` → `…-jurasz-ai`,
 * `…/k3s_2025_05_19/fluxcd` → `…-k3s-2025-05-19-fluxcd`.
 *
 * The mapping is **not injective**: `k3s_2025` and `k3s-2025` produce the same
 * name. Callers that resolve a directory back to a workspace must confirm the
 * `cwd` recorded inside the session files; see {@link claudeProjectDirsForCwd}.
 */
export function claudeSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-")
}

/**
 * Candidate Claude Code project directories for a workspace, most likely first.
 *
 * Returns the slug-derived directory when it exists. It may belong to a
 * different workspace that slugs identically, so the reader still checks the
 * `cwd` on the records it parses.
 */
export function claudeProjectDirsForCwd(cwd: string): string[] {
	const dir = path.join(claudeProjectsDir(), claudeSlug(cwd))
	return isDirectory(dir) ? [dir] : []
}

/** Every Claude Code project directory, or `[]` when the store is absent. */
export function claudeProjectDirs(): string[] {
	return listDirectories(claudeProjectsDir())
}

/**
 * Roots that may hold a Tumble/Roo task store, most likely first.
 *
 * Honours `$AGENT_INTERCHANGE_TUMBLE_STORAGE` (an explicit globalStorage
 * directory, i.e. the one containing `tasks/`), then the `customStoragePath`
 * setting if a VS Code settings file declares one, then the standard
 * globalStorage locations for every VS Code-family app and remote server.
 */
export function tumbleStorageRoots(): string[] {
	const roots: string[] = []
	const override = process.env.AGENT_INTERCHANGE_TUMBLE_STORAGE?.trim()

	if (override) {
		roots.push(override)
	}

	for (const dir of vscodeUserDirs()) {
		const custom = readCustomStoragePath(path.join(dir, "settings.json"))

		if (custom) {
			roots.push(custom)
		}

		for (const id of EXTENSION_IDS) {
			roots.push(path.join(dir, "globalStorage", id))
		}
	}

	return roots.filter((root, index) => roots.indexOf(root) === index).filter((root) => isDirectory(root))
}

/** The `tasks/` directories of every discovered Tumble store. */
export function tumbleTaskRoots(): string[] {
	return tumbleStorageRoots()
		.map((root) => path.join(root, "tasks"))
		.filter((dir) => isDirectory(dir))
}

/** VS Code `User` directories across platforms, variants and remote servers. */
function vscodeUserDirs(): string[] {
	const home = homeDir()
	const dirs: string[] = []

	const platformRoots: string[] = []

	if (process.platform === "darwin") {
		platformRoots.push(path.join(home, "Library", "Application Support"))
	} else if (process.platform === "win32") {
		const appData = process.env.APPDATA
		if (appData) {
			platformRoots.push(appData)
		}
	} else {
		platformRoots.push(path.join(home, ".config"))
	}

	for (const root of platformRoots) {
		for (const app of VSCODE_APP_DIRS) {
			dirs.push(path.join(root, app, "User"))
		}
	}

	// Remote / devcontainer servers keep their own user data tree.
	dirs.push(path.join(home, ".vscode-server", "data", "User"))
	dirs.push(path.join(home, ".vscode-server-insiders", "data", "User"))

	return dirs.filter((dir) => isDirectory(dir))
}

/**
 * Best-effort read of `<extension>.customStoragePath` out of a VS Code
 * `settings.json`. The file is JSONC, so comments and trailing commas are
 * tolerated; anything unparseable simply yields no override.
 */
function readCustomStoragePath(settingsFile: string): string | undefined {
	let raw: string

	try {
		raw = fs.readFileSync(settingsFile, "utf8")
	} catch {
		return undefined
	}

	const stripped = stripJsonComments(raw).replace(/,(\s*[}\]])/g, "$1")

	let parsed: Record<string, unknown>

	try {
		parsed = JSON.parse(stripped) as Record<string, unknown>
	} catch {
		return undefined
	}

	for (const key of ["tumble-code.customStoragePath", "roo-cline.customStoragePath"]) {
		const value = parsed[key]

		if (typeof value === "string" && value.trim()) {
			return value.trim()
		}
	}

	return undefined
}

/**
 * Remove `//` and comments from JSONC, leaving string literals untouched.
 *
 * A scanner rather than a regex: a URL inside a setting value must not be
 * mistaken for a line comment, and a regex that tries to skip string literals
 * has to re-implement escape handling anyway.
 */
function stripJsonComments(input: string): string {
	let out = ""
	let inString = false
	let inLine = false
	let inBlock = false

	for (let i = 0; i < input.length; i++) {
		const ch = input[i]
		const next = input[i + 1]

		if (inLine) {
			if (ch === "\n") {
				inLine = false
				out += ch
			}
			continue
		}

		if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false
				i++
			}
			continue
		}

		if (inString) {
			out += ch
			if (ch === "\\") {
				// Copy the escaped character verbatim so `\"` cannot end the string.
				out += next ?? ""
				i++
			} else if (ch === '"') {
				inString = false
			}
			continue
		}

		if (ch === '"') {
			inString = true
			out += ch
			continue
		}

		if (ch === "/" && next === "/") {
			inLine = true
			i++
			continue
		}

		if (ch === "/" && next === "*") {
			inBlock = true
			i++
			continue
		}

		out += ch
	}

	return out
}

/** Where handoff documents live: `$AGENT_INTERCHANGE_DIR` or an XDG data dir. */
export function handoffDir(): string {
	const override = process.env.AGENT_INTERCHANGE_DIR?.trim()

	if (override) {
		return path.join(override, "handoffs")
	}

	const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(homeDir(), ".local", "share")

	return path.join(dataHome, "agent-interchange", "handoffs")
}

export function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory()
	} catch {
		return false
	}
}

export function listDirectories(parent: string): string[] {
	try {
		return fs
			.readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(parent, entry.name))
	} catch {
		return []
	}
}

/**
 * Path comparison that tolerates trailing separators, `.` segments and symlinks.
 *
 * Two agents reach the same project by whatever path the person typed, so a
 * workspace recorded through a symlink has to match the same workspace recorded
 * canonically — otherwise a session is authorized to be read but never appears
 * in a listing, which for an agent is the same as not existing.
 */
export function samePath(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) {
		return false
	}

	return canonicalPath(a) === canonicalPath(b)
}

/**
 * A path reduced to the one name the filesystem agrees on, or its resolved form
 * when there is nothing on disk to ask — a store records the workspace a session
 * ran in, which may since have been moved or deleted.
 *
 * Memoized: a listing resolves the same handful of workspaces hundreds of times,
 * and the server already pins its own workspace identity for its lifetime.
 */
export function canonicalPath(candidate: string): string {
	const resolved = path.resolve(candidate)
	const cached = canonicalPaths.get(resolved)

	if (cached !== undefined) {
		return cached
	}

	let canonical: string

	try {
		canonical = fs.realpathSync(resolved)
	} catch {
		canonical = resolved
	}

	canonicalPaths.set(resolved, canonical)

	return canonical
}

const canonicalPaths = new Map<string, string>()
