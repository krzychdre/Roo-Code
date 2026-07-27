import { describe, it, expect, beforeEach, vi } from "vitest"

import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import type { SubagentSummary } from "@roo-code/types"

// We mock vscode only to satisfy the import chain in `../../utils/storage`
// (getStorageBasePath reads vscode.workspace.getConfiguration). The actual
// test uses a real temp directory via the custom-storage-path config knob,
// so storage writes hit the real fs.
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue(""), // no custom storage path → use default
		}),
	},
	window: { showErrorMessage: vi.fn() },
}))

import {
	saveSubagentSummaries,
	loadSubagentSummaries,
	getSubagentSummariesFilePath,
	SUBAGENTS_SIDECAR_FILENAME,
} from "../subagentSummariesStore"

function makeSummary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
	return {
		taskId: "child-1",
		parentTaskId: "parent-1",
		index: 0,
		mode: "ask",
		description: "do thing",
		status: "completed",
		tokensIn: 100,
		tokensOut: 200,
		totalCost: 0.001,
		startedAt: 1,
		lastActivityAt: 2,
		finalMessage: "result text",
		...overrides,
	}
}

describe("subagentSummariesStore", () => {
	let tmpRoot: string

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-store-"))
	})

	describe("saveSubagentSummaries + loadSubagentSummaries round-trip", () => {
		it("persists and reloads a list of summaries", async () => {
			const summaries = [
				makeSummary({ taskId: "c1", index: 0, status: "completed" }),
				makeSummary({ taskId: "c2", index: 1, status: "failed", finalMessage: "boom" }),
			]
			await saveSubagentSummaries(tmpRoot, "parent-1", summaries)

			const loaded = await loadSubagentSummaries(tmpRoot, "parent-1")
			expect(loaded).toHaveLength(2)
			expect(loaded.map((s) => s.taskId)).toEqual(["c1", "c2"])
			expect(loaded[1].status).toBe("failed")
			expect(loaded[1].finalMessage).toBe("boom")
		})

		it("overwrites a previous sidecar for the same parent (beginFanOut semantics)", async () => {
			await saveSubagentSummaries(tmpRoot, "parent-1", [makeSummary({ taskId: "old", index: 0 })])
			await saveSubagentSummaries(tmpRoot, "parent-1", [makeSummary({ taskId: "new", index: 0 })])
			const loaded = await loadSubagentSummaries(tmpRoot, "parent-1")
			expect(loaded.map((s) => s.taskId)).toEqual(["new"])
		})

		it("keeps sidecars for different parents independent", async () => {
			await saveSubagentSummaries(tmpRoot, "parent-1", [makeSummary({ taskId: "c1" })])
			await saveSubagentSummaries(tmpRoot, "parent-2", [makeSummary({ taskId: "c2", parentTaskId: "parent-2" })])
			expect((await loadSubagentSummaries(tmpRoot, "parent-1")).map((s) => s.taskId)).toEqual(["c1"])
			expect((await loadSubagentSummaries(tmpRoot, "parent-2")).map((s) => s.taskId)).toEqual(["c2"])
		})
	})

	describe("loadSubagentSummaries graceful degradation", () => {
		it("returns [] when the sidecar does not exist (pre-fix history item)", async () => {
			const loaded = await loadSubagentSummaries(tmpRoot, "never-fanned-out")
			expect(loaded).toEqual([])
		})

		it("returns [] when the sidecar is not valid JSON (corrupt file, never throws)", async () => {
			const filePath = await getSubagentSummariesFilePath(tmpRoot, "parent-1")
			await fs.writeFile(filePath, "{not valid json", "utf8")
			const loaded = await loadSubagentSummaries(tmpRoot, "parent-1")
			expect(loaded).toEqual([])
		})

		it("returns [] when the sidecar JSON is not an array", async () => {
			const filePath = await getSubagentSummariesFilePath(tmpRoot, "parent-1")
			await fs.writeFile(filePath, JSON.stringify({ not: "an array" }), "utf8")
			const loaded = await loadSubagentSummaries(tmpRoot, "parent-1")
			expect(loaded).toEqual([])
		})

		it("filters out entries that do not look like summaries (loose shape guard)", async () => {
			const filePath = await getSubagentSummariesFilePath(tmpRoot, "parent-1")
			await fs.writeFile(
				filePath,
				JSON.stringify([
					makeSummary({ taskId: "good" }),
					{ taskId: "no-parent", index: 0 }, // missing parentTaskId
					{ not: "a summary" },
					null,
					"string-entry",
				]),
				"utf8",
			)
			const loaded = await loadSubagentSummaries(tmpRoot, "parent-1")
			expect(loaded.map((s) => s.taskId)).toEqual(["good"])
		})
	})

	describe("getSubagentSummariesFilePath", () => {
		it("resolves to <storageBasePath>/tasks/<parentTaskId>/subagents.json", async () => {
			const filePath = await getSubagentSummariesFilePath(tmpRoot, "parent-1")
			expect(filePath).toBe(path.join(tmpRoot, "tasks", "parent-1", SUBAGENTS_SIDECAR_FILENAME))
			expect(path.basename(filePath)).toBe(SUBAGENTS_SIDECAR_FILENAME)
		})

		it("creates the parent task directory if it does not exist", async () => {
			const filePath = await getSubagentSummariesFilePath(tmpRoot, "parent-1")
			// The file does not need to exist, but the directory must have
			// been created (saveSubagentSummaries relies on this).
			const dir = path.dirname(filePath)
			const stat = await fs.stat(dir)
			expect(stat.isDirectory()).toBe(true)
		})

		it("rejects an empty storage path instead of writing a relative path", async () => {
			// `path.join("", "tasks", id)` is relative, which would create the
			// sidecar under the process cwd (the repo, when running tests).
			await expect(getSubagentSummariesFilePath("", "parent-1")).rejects.toThrow(/globalStoragePath is required/)
			await expect(saveSubagentSummaries("", "parent-1", [makeSummary()])).rejects.toThrow(
				/globalStoragePath is required/,
			)
			expect(await loadSubagentSummaries("", "parent-1")).toEqual([])
		})
	})
})
