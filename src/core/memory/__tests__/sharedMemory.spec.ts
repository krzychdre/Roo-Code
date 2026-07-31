import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { getAutoMemEntrypoint, getAutoMemPath, initMemoryPaths, isAutoMemPath, resetMemoryPaths } from "../paths"
import { logger } from "../../../utils/logging"

/**
 * Sharing the memory directory with Claude Code.
 *
 * The two layouts differ only in the base and the per-project segment, so
 * sharing is a path substitution — these tests pin that substitution, the
 * precedence against an explicit directory, and the one hazard it introduces:
 * Claude Code's slug is lossy, so two workspaces can land on one directory.
 */

const GLOBAL_STORAGE = "/home/user/.vscode/ext-storage"
const CWD = "/home/user/my-project"

describe("memory shared with Claude Code", () => {
	let claudeDir: string

	beforeEach(() => {
		claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-memory-"))
		process.env.CLAUDE_CONFIG_DIR = claudeDir
	})

	afterEach(() => {
		resetMemoryPaths()
		delete process.env.CLAUDE_CONFIG_DIR
		fs.rmSync(claudeDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("stays in extension storage when sharing is off", () => {
		initMemoryPaths(GLOBAL_STORAGE, () => ({}))

		expect(getAutoMemPath(CWD)).toBe(
			path.join(GLOBAL_STORAGE, "memory", "projects", "_home_user_my-project", "memory") + path.sep,
		)
	})

	it("resolves to Claude Code's directory for the same workspace", () => {
		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: true }))

		expect(getAutoMemPath(CWD)).toBe(path.join(claudeDir, "projects", "-home-user-my-project", "memory") + path.sep)
		expect(getAutoMemEntrypoint(CWD)).toBe(
			path.join(claudeDir, "projects", "-home-user-my-project", "memory", "MEMORY.md"),
		)
	})

	it("lets an explicit directory win over sharing", () => {
		initMemoryPaths(GLOBAL_STORAGE, () => ({
			autoMemoryShareWithClaudeCode: true,
			autoMemoryDirectory: "/srv/memories",
		}))

		expect(getAutoMemPath(CWD)).toBe(
			path.join("/srv/memories", "projects", "_home_user_my-project", "memory") + path.sep,
		)
	})

	it("takes effect without a reload when the setting is toggled", () => {
		let shared = false
		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: shared }))

		const before = getAutoMemPath(CWD)
		shared = true
		const after = getAutoMemPath(CWD)

		expect(after).not.toBe(before)
		expect(after).toContain(claudeDir)
	})

	it("keeps the write carve-out pointed at the shared directory", () => {
		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: true }))

		const shared = path.join(claudeDir, "projects", "-home-user-my-project", "memory")

		expect(isAutoMemPath(path.join(shared, "MEMORY.md"), CWD)).toBe(true)
		expect(isAutoMemPath(path.join(GLOBAL_STORAGE, "memory", "MEMORY.md"), CWD)).toBe(false)
	})

	it("warns when the shared directory belongs to a workspace that slugs the same", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
		const projectDir = path.join(claudeDir, "projects", "-home-user-my-project")
		fs.mkdirSync(projectDir, { recursive: true })
		// `/home/user/my_project` and `/home/user/my-project` produce this same name.
		fs.writeFileSync(
			path.join(projectDir, "s1.jsonl"),
			JSON.stringify({ type: "user", cwd: "/home/user/my_project", sessionId: "s1" }) + "\n",
			"utf8",
		)

		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: true }))
		getAutoMemPath(CWD)

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]![0]).toContain("/home/user/my_project")
	})

	it("stays quiet when the directory belongs to this workspace", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})
		const projectDir = path.join(claudeDir, "projects", "-home-user-my-project")
		fs.mkdirSync(projectDir, { recursive: true })
		fs.writeFileSync(
			path.join(projectDir, "s1.jsonl"),
			JSON.stringify({ type: "user", cwd: CWD, sessionId: "s1" }) + "\n",
			"utf8",
		)

		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: true }))
		getAutoMemPath(CWD)

		expect(warn).not.toHaveBeenCalled()
	})

	it("stays quiet when Claude Code has no sessions for the workspace yet", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {})

		initMemoryPaths(GLOBAL_STORAGE, () => ({ autoMemoryShareWithClaudeCode: true }))
		getAutoMemPath(CWD)

		expect(warn).not.toHaveBeenCalled()
	})
})
