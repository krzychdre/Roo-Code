// npx vitest run src/__tests__/esbuild.spec.ts
//
// Regression test for CodeQL alerts #2, #3, #4, #5 (shell injection in the
// Windows-only `attrib` cleanup inside rmDir). The sink must invoke `attrib`
// via execFileSync with an argv array (no shell) so that `dirPath` — sourced
// from copyPaths (dstDir/dstRelPath) and from __dirname → buildDir — is passed
// as a single argument and cannot inject shell metacharacters.

import type { Stats } from "node:fs"

import { copyPaths } from "../esbuild.js"

const { execFileSyncMock, execSyncMock, fsMocks } = vi.hoisted(() => ({
	execFileSyncMock: vi.fn(),
	execSyncMock: vi.fn(),
	fsMocks: {
		rmSync: vi.fn(),
		lstatSync: vi.fn(),
		existsSync: vi.fn(),
		mkdirSync: vi.fn(),
		copyFileSync: vi.fn(),
		readdirSync: vi.fn(),
	},
}))

vi.mock("child_process", () => ({
	execFileSync: execFileSyncMock,
	execSync: execSyncMock,
}))

vi.mock("fs", () => ({
	rmSync: fsMocks.rmSync,
	lstatSync: fsMocks.lstatSync,
	existsSync: fsMocks.existsSync,
	mkdirSync: fsMocks.mkdirSync,
	copyFileSync: fsMocks.copyFileSync,
	readdirSync: fsMocks.readdirSync,
}))

describe("rmDir Windows attrib path — shell-injection regression (CodeQL #2-#5)", () => {
	const originalPlatform = process.platform

	beforeEach(() => {
		execFileSyncMock.mockReset()
		execSyncMock.mockReset()
		fsMocks.rmSync.mockReset()
		fsMocks.lstatSync.mockReset()
		fsMocks.existsSync.mockReset()
		fsMocks.mkdirSync.mockReset()
		fsMocks.copyFileSync.mockReset()
		fsMocks.readdirSync.mockReset()
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
		vi.restoreAllMocks()
	})

	it("invokes attrib via execFileSync argv array, not execSync shell string", () => {
		// Force the Windows code path so the `attrib` branch is reached.
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })

		// fs.rmSync always fails with a retryable error so rmDir exhausts its
		// retries and reaches its final-attempt alternative-cleanup branch,
		// which is the only place `attrib` is invoked.
		fsMocks.rmSync.mockImplementation(() => {
			const err = new Error("directory not empty") as Error & { code?: string }
			err.code = "ENOTEMPTY"
			throw err
		})

		// Skip the exponential-backoff busy-wait between retries (advancing the
		// clock past every delay on the first inner Date.now() call).
		let clock = 1_000_000
		vi.spyOn(Date, "now").mockImplementation(() => (clock += 10_000))

		// Drive rmDir through the exported copyPaths surface: a source entry
		// that reports as a directory, plus an existing destination, makes
		// copyPaths call rmDir(...) before anything else.
		fsMocks.lstatSync.mockReturnValue({ isDirectory: () => true } as unknown as Stats)
		fsMocks.existsSync.mockReturnValue(true)

		// rmDir's final attempt rethrows, so copyPaths (no `optional` flag)
		// rethrows it — expected. The important invariant is that `attrib` was
		// already invoked by the time it does.
		expect(() => copyPaths([["src", "dst"]], "/src-root", "/dst-root")).toThrow()

		// The fix: `attrib` is launched with an argv array (no shell), passing
		// dirPath as a single argument rather than interpolating it into a
		// shell command string.
		expect(execFileSyncMock).toHaveBeenCalledWith(
			"attrib",
			expect.arrayContaining(["-R", expect.any(String), "/S", "/D"]),
			expect.anything(),
		)
		expect(execSyncMock).not.toHaveBeenCalled()
	})
})
