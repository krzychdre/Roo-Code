// cd src && npx vitest run core/artifacts/__tests__/spillRoundTrip.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ReadArtifactTool } from "../../tools/ReadArtifactTool"
import { ArtifactStore } from "../ArtifactStore"
import { applyToolResultSpill } from "../spillPolicy"

/**
 * End-to-end acceptance check for WS-B, on the real filesystem: a huge tool
 * result is spilled to a real artifact, and a follow-up `read_artifact` with
 * `search` recovers a line that the preview does not contain.
 *
 * Nothing here is mocked except VS Code itself (aliased globally), so this also
 * covers `getTaskDirectoryPath`, directory creation and the tool's own file I/O.
 */
describe("spill round trip (real filesystem)", () => {
	const taskId = "round-trip-task"
	let globalStoragePath: string
	let pushToolResult: ReturnType<typeof vi.fn>
	let task: Task

	beforeEach(() => {
		globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), "spill-round-trip-"))
		pushToolResult = vi.fn()
		task = {
			taskId,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			say: vi.fn().mockResolvedValue(undefined),
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
			providerRef: {
				deref: () => ({ context: { globalStorageUri: { fsPath: globalStoragePath } } }),
			},
		} as unknown as Task
	})

	afterEach(() => {
		fs.rmSync(globalStoragePath, { recursive: true, force: true })
	})

	it("spills a 300 KB search result and finds a line beyond the preview with search", async () => {
		// 3000 matches of 100 chars, with the needle parked in the middle where
		// neither the head nor the tail of the preview can reach it.
		const lines = Array.from({ length: 3000 }, (_, index) =>
			index === 1500
				? "src/deep/needle.ts:42: NEEDLE_MARKER found here".padEnd(100, "-")
				: `src/vendor/file-${index}.ts:1: ordinary match`.padEnd(100, "-"),
		)
		const hugeResult = lines.join("\n")
		expect(Buffer.byteLength(hugeResult, "utf8")).toBeGreaterThan(290_000)

		const store = await ArtifactStore.forTask(globalStoragePath, taskId)
		const outcome = applyToolResultSpill(hugeResult, "search_files", { store, maxInlineBytes: 24 * 1024 })

		// The conversation keeps a preview only, and the needle is not in it.
		expect(outcome.artifactId).toMatch(/^tool-\d+\.txt$/)
		expect(outcome.text).not.toContain("NEEDLE_MARKER")
		expect(Buffer.byteLength(outcome.text, "utf8")).toBeLessThan(24 * 1024 + 512)
		expect(outcome.text).toContain(`artifact "${outcome.artifactId}"`)

		// The artifact on disk holds the full result.
		const artifactPath = path.join(store.getTaskDir(), "artifacts", outcome.artifactId!)
		expect(fs.readFileSync(artifactPath, "utf8")).toBe(hugeResult)

		// read_artifact with `search` recovers the line the preview dropped.
		const tool = new ReadArtifactTool()
		await tool.execute({ artifact_id: outcome.artifactId!, search: "NEEDLE_MARKER" }, task, {
			pushToolResult,
		} as never)

		const readResult = pushToolResult.mock.calls[0][0] as string
		expect(readResult).toContain("Total matches: 1")
		expect(readResult).toContain("NEEDLE_MARKER")
		expect(readResult).toContain("1501 |")
		expect(task.didToolFailInCurrentTurn).toBe(false)
	})

	it("pages through the artifact with offset and limit", async () => {
		const hugeResult = Array.from({ length: 2000 }, (_, index) => `line ${index}`.padEnd(200, "x")).join("\n")

		const store = await ArtifactStore.forTask(globalStoragePath, taskId)
		const outcome = applyToolResultSpill(hugeResult, "execute_command", { store, maxInlineBytes: 24 * 1024 })
		expect(outcome.artifactId).toBeDefined()

		const tool = new ReadArtifactTool()
		await tool.execute({ artifact_id: outcome.artifactId!, offset: 100_000, limit: 4096 }, task, {
			pushToolResult,
		} as never)

		const readResult = pushToolResult.mock.calls[0][0] as string
		expect(readResult).toContain(`[Artifact: ${outcome.artifactId}]`)
		expect(readResult).toContain("Showing bytes 100000-104096")
		expect(readResult).toContain("TRUNCATED")
	})

	it("caps a single read at the inline budget even when the model asks for more", async () => {
		const hugeResult = "q".repeat(400_000)

		const store = await ArtifactStore.forTask(globalStoragePath, taskId)
		const saved = store.save("tool", hugeResult)

		const tool = new ReadArtifactTool()
		await tool.execute({ artifact_id: saved.id, limit: 400_000 }, task, { pushToolResult } as never)

		const readResult = pushToolResult.mock.calls[0][0] as string
		expect(readResult).toContain("Showing bytes 0-24576")
		expect(readResult).toContain("TRUNCATED")
	})
})
