// cd src && npx vitest run core/artifacts/__tests__/pruneRoundTrip.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { Anthropic } from "@anthropic-ai/sdk"

import type { Task } from "../../task/Task"
import { pruneToolResults, PRUNE_NOTICE_PREFIX } from "../../condense/toolResultPruner"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../../task-persistence/apiMessages"
import { ReadArtifactTool } from "../../tools/ReadArtifactTool"
import { ArtifactStore } from "../ArtifactStore"

/**
 * End-to-end acceptance check for WS-C, on the real filesystem.
 *
 * Pruning is the one context pass that REWRITES the stored history: the
 * original text is on disk and the conversation keeps only a preview plus an
 * artifact id. Two things therefore have to hold across a resume, and this test
 * pins both:
 *
 * 1. the pruned history survives the JSON round trip through
 *    `api_conversation_history.json`, so a reopened task still shows the model
 *    the preview and the id, and
 * 2. `read_artifact` with that id recovers a line the preview never contained.
 *
 * Nothing is mocked except VS Code itself (aliased globally), so this also
 * covers `getTaskDirectoryPath`, `safeWriteJson` and the tool's own file I/O.
 */
describe("prune round trip (real filesystem)", () => {
	const taskId = "prune-round-trip-task"
	let globalStoragePath: string
	let pushToolResult: ReturnType<typeof vi.fn>
	let task: Task

	beforeEach(() => {
		globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), "prune-round-trip-"))
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

	it("survives a save/reload cycle and read_artifact recovers the pruned original", async () => {
		// 400 lines with the needle parked in the middle, where neither the head
		// nor the tail of a 20/20 preview can reach it.
		const lines = Array.from({ length: 400 }, (_, index) =>
			index === 200 ? "PRUNE_NEEDLE lives here".padEnd(60, "-") : `ordinary line ${index}`.padEnd(60, "-"),
		)
		const original = lines.join("\n")

		const messages: ApiMessage[] = [
			{ role: "user", content: "the task", ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "use-1", name: "search_files", input: { regex: "x" } }],
				ts: 2,
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "use-1", content: original }], ts: 3 },
			{ role: "assistant", content: [{ type: "text", text: "I will keep going." }], ts: 4 },
		]

		const store = await ArtifactStore.forTask(globalStoragePath, taskId)
		const pruned = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: 4096, store })

		expect(pruned.prunedCount).toBe(1)
		const artifactId = pruned.artifacts[0]
		expect(artifactId).toMatch(/^prune-\d+\.txt$/)

		// Persist exactly the way the task does, then reload the way a resume does.
		await saveApiMessages({ messages: pruned.messages, taskId, globalStoragePath })
		const reloaded = await readApiMessages({ taskId, globalStoragePath })

		expect(reloaded).toHaveLength(messages.length)

		const block = (reloaded[2].content as Anthropic.Messages.ContentBlockParam[])[0]
		const reloadedText = (block as Anthropic.Messages.ToolResultBlockParam).content as string

		// The preview and, crucially, the artifact id survived the round trip.
		expect(reloadedText.startsWith(PRUNE_NOTICE_PREFIX)).toBe(true)
		expect(reloadedText).toContain(`artifact "${artifactId}"`)
		expect(reloadedText).toContain(`Use read_artifact with artifact_id "${artifactId}"`)
		expect(reloadedText).not.toContain("PRUNE_NEEDLE")

		// Pairing is intact after the reload, so the API will accept the history.
		const toolUse = (reloaded[1].content as Anthropic.Messages.ContentBlockParam[])[0]
		expect((toolUse as Anthropic.Messages.ToolUseBlockParam).id).toBe("use-1")
		expect((block as Anthropic.Messages.ToolResultBlockParam).tool_use_id).toBe("use-1")

		// The assistant's own words were never touched.
		expect((reloaded[3].content as Anthropic.Messages.TextBlockParam[])[0].text).toBe("I will keep going.")

		// And the model can get the dropped middle back with the id it was given.
		const tool = new ReadArtifactTool()
		await tool.execute({ artifact_id: artifactId, search: "PRUNE_NEEDLE" }, task, {
			pushToolResult,
		} as never)

		const readResult = pushToolResult.mock.calls[0][0] as string
		expect(readResult).toContain("Total matches: 1")
		expect(readResult).toContain("PRUNE_NEEDLE")

		// The artifact on disk is the original, byte for byte.
		const artifactPath = path.join(store.getTaskDir(), "artifacts", artifactId)
		expect(fs.readFileSync(artifactPath, "utf8")).toBe(original)
	})
})
