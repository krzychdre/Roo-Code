// cd src && npx vitest run core/config/__tests__/CustomModesManager.orphanedRules.spec.ts

import type { Mock } from "vitest"

import * as path from "path"
import * as fs from "fs/promises"

import * as yaml from "yaml"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { getGlobalRooDirectory } from "../../../services/roo-config"
import { logger } from "../../../utils/logging"
import { GlobalFileNames } from "../../../shared/globalFileNames"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn(),
		createFileSystemWatcher: vi.fn(),
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")
vi.mock("../../../services/roo-config", () => ({ getGlobalRooDirectory: vi.fn() }))
vi.mock("../../../utils/logging", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}))

/** A `readdir(..., { withFileTypes: true })` entry, only as much as the scan reads. */
function dir(name: string) {
	return { name, isDirectory: () => true, isFile: () => false }
}

function file(name: string) {
	return { name, isDirectory: () => false, isFile: () => true }
}

describe("CustomModesManager orphaned rules directories", () => {
	const mockStoragePath = `${path.sep}mock${path.sep}settings`
	const mockSettingsPath = path.join(mockStoragePath, "settings", GlobalFileNames.customModes)
	const mockWorkspacePath = path.resolve("/mock/workspace")
	const mockGlobalRooDir = path.resolve("/mock/home/.roo")
	const mockWorkspaceRooDir = path.join(mockWorkspacePath, ".roo")

	let manager: CustomModesManager

	/** Modes declared in the global settings file for a given test. */
	function withCustomModes(slugs: string[]) {
		;(fs.readFile as Mock).mockImplementation(async (p: string) => {
			if (p === mockSettingsPath) {
				return yaml.stringify({
					customModes: slugs.map((slug) => ({
						slug,
						name: slug,
						roleDefinition: "role",
						groups: ["read"],
					})),
				})
			}
			throw new Error("File not found")
		})
	}

	/** Directory listings keyed by path; anything else behaves as "no such directory". */
	function withRooDirectories(listings: Record<string, ReturnType<typeof dir>[]>) {
		;(fs.readdir as Mock).mockImplementation(async (p: string) => {
			if (p in listings) {
				return listings[p]
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
		})
	}

	/** The scan is fire-and-forget, so let its microtasks drain before asserting. */
	async function flush() {
		for (let i = 0; i < 20; i++) {
			await new Promise((resolve) => setImmediate(resolve))
		}
	}

	function warnedPaths(): string[] {
		return (logger.warn as Mock).mock.calls
			.filter(([message]) => String(message).includes("matches no mode"))
			.map(([, meta]) => meta.path)
	}

	beforeEach(() => {
		const mockContext = {
			globalState: { get: vi.fn(), update: vi.fn(), keys: vi.fn(() => []), setKeysForSync: vi.fn() },
			globalStorageUri: { fsPath: mockStoragePath },
		} as unknown as vscode.ExtensionContext

		;(vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: mockWorkspacePath } }]
		;(vscode.workspace.onDidSaveTextDocument as Mock).mockReturnValue({ dispose: vi.fn() })
		;(getWorkspacePath as Mock).mockReturnValue(mockWorkspacePath)
		;(getGlobalRooDirectory as Mock).mockReturnValue(mockGlobalRooDir)
		;(fileExistsAtPath as Mock).mockImplementation(async (p: string) => p === mockSettingsPath)
		;(fs.mkdir as Mock).mockResolvedValue(undefined)
		;(fs.writeFile as Mock).mockResolvedValue(undefined)

		withCustomModes([])
		withRooDirectories({})

		manager = new CustomModesManager(mockContext, vi.fn())
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("warns about a rules directory whose slug matches no mode", async () => {
		// The real-world case: the directory is named after the mode's display NAME
		// ("Code Reviewer" -> code-reviewer) while the slug is "reviewer", so the rules
		// are silently never loaded.
		withCustomModes(["reviewer"])
		withRooDirectories({
			[mockGlobalRooDir]: [dir("rules-reviewer"), dir("rules-code-reviewer")],
		})

		await manager.getCustomModes()
		await flush()

		expect(warnedPaths()).toEqual([path.join(mockGlobalRooDir, "rules-code-reviewer")])
	})

	it("does not warn for built-in mode slugs", async () => {
		withRooDirectories({
			[mockGlobalRooDir]: [dir("rules-code"), dir("rules-architect"), dir("rules-debug")],
		})

		await manager.getCustomModes()
		await flush()

		expect(warnedPaths()).toEqual([])
	})

	it("ignores plain `rules` directories, files, and unrelated entries", async () => {
		withRooDirectories({
			[mockGlobalRooDir]: [dir("rules"), dir("commands"), dir("skills"), file("rules-notadir")],
		})

		await manager.getCustomModes()
		await flush()

		expect(warnedPaths()).toEqual([])
	})

	it("scans the workspace .roo directory as well", async () => {
		withRooDirectories({
			[mockWorkspaceRooDir]: [dir("rules-ghost")],
		})

		await manager.getCustomModes()
		await flush()

		expect(warnedPaths()).toEqual([path.join(mockWorkspaceRooDir, "rules-ghost")])
	})

	it("warns only once per session, not on every cache refresh", async () => {
		withRooDirectories({
			[mockGlobalRooDir]: [dir("rules-ghost")],
		})

		await manager.getCustomModes()
		await flush()
		// Expire the 10s cache so the second call genuinely re-loads (and would
		// re-scan) rather than returning early.
		;(manager as any).cachedAt = 0
		await manager.getCustomModes()
		await flush()

		expect(warnedPaths()).toHaveLength(1)
	})

	it("never lets a failing scan break mode loading", async () => {
		;(fs.readdir as Mock).mockRejectedValue(new Error("EACCES"))
		withCustomModes(["reviewer"])

		const modes = await manager.getCustomModes()
		await flush()

		expect(modes.map((m) => m.slug)).toEqual(["reviewer"])
		expect(warnedPaths()).toEqual([])
	})
})
