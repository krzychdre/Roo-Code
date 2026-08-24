// cd src && npx vitest run core/context-management/__tests__/microcompact-artifact-notice.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { Anthropic } from "@anthropic-ai/sdk"

import { ArtifactStore } from "../../artifacts/ArtifactStore"
import { applyToolResultSpill } from "../../artifacts/spillPolicy"
import { pruneToolResults } from "../../condense/toolResultPruner"
import { ApiMessage } from "../../task-persistence/apiMessages"

import { applyMicrocompactCleared, microcompactToolResults, MICROCOMPACT_CLEARED_PLACEHOLDER } from "../microcompact"

/**
 * A tool result can be reduced twice: first by the spill policy or the pruner,
 * which move the full text to a task artifact and leave a notice quoting its id,
 * and later by microcompaction, which drops whatever body is left.
 *
 * That second pass must keep the notice line. It is the ONLY place the artifact
 * id survives, so dropping it leaves the full output on disk with no name the
 * model can pass to `read_artifact`, and the generic placeholder then tells the
 * model to re-run work whose result is already sitting there.
 */

/** ~10 KB of short lines, enough for the pruner to act on. */
function bigResult(tag: string): string {
	return Array.from({ length: 200 }, (_, index) => `${tag} line ${index}`.padEnd(50, ".")).join("\n")
}

function resultContent(messages: ApiMessage[], toolUseId: string): Anthropic.Messages.ToolResultBlockParam["content"] {
	for (const msg of messages) {
		if (msg.role !== "user" || !Array.isArray(msg.content)) continue
		for (const block of msg.content) {
			if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
				return (block as Anthropic.Messages.ToolResultBlockParam).content
			}
		}
	}
	return undefined
}

describe("microcompaction keeps artifact notices", () => {
	let taskDir: string
	let store: ArtifactStore

	beforeEach(() => {
		taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "microcompact-notice-"))
		store = new ArtifactStore(taskDir)
	})

	afterEach(() => {
		fs.rmSync(taskDir, { recursive: true, force: true })
	})

	it("keeps the prune notice when a later round clears a pruned result (string content)", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "search_files", input: {} }], ts: 1 },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: bigResult("a") }], ts: 2 },
			...Array.from({ length: 6 }, (_, i) => ({
				role: "assistant" as const,
				content: `filler ${i}`,
				ts: 10 + i,
			})),
		]

		const pruned = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: 4096, store })
		expect(pruned.prunedCount).toBe(1)
		const artifactId = pruned.artifacts[0]

		// Turn N + k: microcompaction picks the same result for the send-time strip.
		const cleared = applyMicrocompactCleared(pruned.messages, new Set(["old"]))
		const content = resultContent(cleared, "old") as string

		expect(content.endsWith(MICROCOMPACT_CLEARED_PLACEHOLDER)).toBe(true)
		expect(content).toContain(`artifact "${artifactId}"`)
		expect(content).toContain("read_artifact")
		// Only the notice line survives above the placeholder, not the preview.
		expect(content.split("\n")).toHaveLength(2)
	})

	it("finds the notice when it is not the first text block of an array-shaped result", () => {
		const spilled = applyToolResultSpill(bigResult("spilled"), "search_files", {
			store,
			maxInlineBytes: 4096,
		})
		expect(spilled.artifactId).toBeDefined()

		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			{ role: "assistant", content: [{ type: "tool_use", id: "multi", name: "search_files", input: {} }], ts: 1 },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "multi",
						content: [
							// A preamble block ahead of the notice: joining the blocks
							// into one string would bury the notice and lose the id.
							{ type: "text", text: "Command executed in /workspace" },
							{ type: "text", text: spilled.text },
						],
					},
				],
				ts: 2,
			},
		]

		const cleared = applyMicrocompactCleared(messages, new Set(["multi"]))
		const content = resultContent(cleared, "multi") as string

		expect(content.endsWith(MICROCOMPACT_CLEARED_PLACEHOLDER)).toBe(true)
		expect(content).toContain(`artifact "${spilled.artifactId}"`)
	})

	it("keeps the notice on the destructive selection path too", () => {
		const messages: ApiMessage[] = [
			{ role: "user", content: "task", ts: 0 },
			{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "search_files", input: {} }], ts: 1 },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: bigResult("a") }], ts: 2 },
			...Array.from({ length: 8 }, (_, i) => ({
				role: "assistant" as const,
				content: `filler ${i}`,
				ts: 10 + i,
			})),
		]

		const pruned = pruneToolResults(messages, { keepBoundary: 3, budgetBytes: 4096, store })
		const artifactId = pruned.artifacts[0]

		const result = microcompactToolResults(pruned.messages, {
			targetChars: Number.POSITIVE_INFINITY,
			minKeep: 0,
			clearFloorChars: 1,
		})

		expect(result.clearedCount).toBe(1)
		const content = resultContent(result.messages, "old") as string
		expect(content).toContain(`artifact "${artifactId}"`)
		expect(content.endsWith(MICROCOMPACT_CLEARED_PLACEHOLDER)).toBe(true)
	})
})
