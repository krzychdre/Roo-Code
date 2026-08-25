// npx vitest run src/core/prompts/sections/__tests__/prefix-determinism.spec.ts
//
// WS-F regression guards for the three nondeterminism fixes. Each test here
// fails if its sort is deleted, which is the point: the sorts look like tidying
// and would otherwise be removed by the next person who "simplifies" them.
//
// The failure mode they protect against is not a crash. It is the same prompt
// coming out with different bytes on the next build, which silently costs a
// full prefix re-prefill on every cache-aware provider.

vi.mock("fs/promises")

vi.mock("os", async () => ({
	...(await vi.importActual("os")),
	homedir: vi.fn().mockReturnValue("/mock/home"),
}))

// One rules directory, so the test measures ordering INSIDE a directory tree
// rather than the (already fixed) order of the directory list.
vi.mock("../../../../services/roo-config", () => ({
	getRooDirectoriesForCwd: vi.fn().mockImplementation((cwd: string) => [`${cwd}/.roo`]),
	getAllRooDirectoriesForCwd: vi.fn().mockImplementation((cwd: string) => Promise.resolve([`${cwd}/.roo`])),
	getAgentsDirectoriesForCwd: vi.fn().mockImplementation((cwd: string) => Promise.resolve([cwd])),
	getGlobalRooDirectory: vi.fn().mockReturnValue("/mock/home/.roo"),
}))

import fs from "fs/promises"
import type { PathLike } from "fs"

import type { SkillMetadata } from "../../../../shared/skills"
import { getSkillsSection } from "../skills"
import { loadRuleFiles } from "../custom-instructions"

const readFileMock = vi.fn()
const statMock = vi.fn()
const readdirMock = vi.fn()
const realpathMock = vi.fn().mockImplementation((p: string) => Promise.resolve(p))

fs.readFile = readFileMock as any
fs.stat = statMock as any
fs.readdir = readdirMock as any
fs.realpath = realpathMock as any

describe("skills section ordering", () => {
	/**
	 * `SkillsManager` stores skills in a Map filled while scanning directories,
	 * so its iteration order is `fs.readdir` order: not sorted, and not stable
	 * across a rescan. Reversing the manager's answer must not move a byte.
	 */
	const skills: SkillMetadata[] = [
		{
			name: "alpha-skill",
			description: "First skill.",
			path: "/skills/alpha-skill/SKILL.md",
			source: "global",
			modeSlugs: undefined,
		},
		{
			name: "beta-skill",
			description: "Second skill.",
			path: "/skills/beta-skill/SKILL.md",
			source: "project",
			modeSlugs: undefined,
		},
		{
			name: "gamma-skill",
			description: "Third skill.",
			path: "/skills/gamma-skill/SKILL.md",
			source: "global",
			modeSlugs: undefined,
		},
	]

	const managerReturning = (list: SkillMetadata[]) => ({
		getSkillsForMode: () => list,
	})

	it("renders identical bytes whatever order the manager returns", async () => {
		const forward = await getSkillsSection(managerReturning(skills) as never, "code")
		const reversed = await getSkillsSection(managerReturning([...skills].reverse()) as never, "code")

		expect(reversed).toStrictEqual(forward)

		// Not vacuous: the section really lists all three skills, sorted by name.
		expect(forward.indexOf("alpha-skill")).toBeLessThan(forward.indexOf("beta-skill"))
		expect(forward.indexOf("beta-skill")).toBeLessThan(forward.indexOf("gamma-skill"))
	})
})

describe("rule file ordering", () => {
	/**
	 * Two rule files that share a basename in different subdirectories. Their
	 * basenames compare equal, so before the fix the comparator returned 0 and
	 * their relative order was whatever `fs.readdir` (and the `Promise.all`
	 * completion race) happened to produce. The full path is now the tie-breaker.
	 *
	 * The other half of that fix, pinning `localeCompare` to "en", cannot be
	 * exercised in-process: it only shows up under a different ICU locale.
	 */
	const dirEntry = (parentPath: string, name: string) => ({
		name,
		isFile: () => true,
		isSymbolicLink: () => false,
		parentPath,
	})

	const entries = [
		dirEntry("/fake/path/.roo/rules/backend", "rules.md"),
		dirEntry("/fake/path/.roo/rules/frontend", "rules.md"),
	]

	beforeEach(() => {
		vi.clearAllMocks()

		// Anything ending in .md is a file; everything else is a directory, which
		// is what `directoryExists` asks about.
		statMock.mockImplementation((p: PathLike) => {
			const isMarkdown = p.toString().endsWith(".md")
			return Promise.resolve({
				isFile: () => isMarkdown,
				isDirectory: () => !isMarkdown,
			}) as never
		})

		readFileMock.mockImplementation((p: PathLike) => {
			const normalized = p.toString().replace(/\\/g, "/")
			if (normalized.includes("/backend/")) {
				return Promise.resolve("Backend rule body")
			}
			if (normalized.includes("/frontend/")) {
				return Promise.resolve("Frontend rule body")
			}
			return Promise.reject({ code: "ENOENT" })
		})
	})

	it("renders identical bytes whatever order readdir returns", async () => {
		readdirMock.mockResolvedValueOnce(entries as never)
		const forward = await loadRuleFiles("/fake/path")

		readdirMock.mockResolvedValueOnce([...entries].reverse() as never)
		const reversed = await loadRuleFiles("/fake/path")

		expect(reversed).toStrictEqual(forward)

		// Not vacuous: both files really are in the output, and the tie is broken
		// by full path, so backend precedes frontend in both builds.
		expect(forward).toContain("Backend rule body")
		expect(forward).toContain("Frontend rule body")
		expect(forward.indexOf("Backend rule body")).toBeLessThan(forward.indexOf("Frontend rule body"))
	})
})
