// cd src && npx vitest run core/task/__tests__/TaskLifecycle.artifact-cleanup.spec.ts

// dispose() runs on abort, on completion and when the user hits Stop, and the
// very same task can be rehydrated straight afterwards with a history that
// still cites its spilled artifacts. So dispose() may clean up streamed command
// output (pre-existing behaviour, orphan-aware elsewhere) but must NOT touch
// `<taskDir>/artifacts`: those files are reclaimed when the task itself is
// deleted, because `deleteTaskWithId` removes the whole task directory.

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

import { TaskLifecycle, type TaskLifecycleAccess } from "../TaskLifecycle"

const taskId = "dispose-artifacts-task"

describe("TaskLifecycle#dispose - artifact retention", () => {
	let globalStoragePath: string
	let taskDir: string
	let artifactsDir: string
	let commandOutputDir: string

	beforeEach(() => {
		globalStoragePath = fs.mkdtempSync(path.join(os.tmpdir(), "dispose-artifacts-"))
		taskDir = path.join(globalStoragePath, "tasks", taskId)
		artifactsDir = path.join(taskDir, "artifacts")
		commandOutputDir = path.join(taskDir, "command-output")

		fs.mkdirSync(artifactsDir, { recursive: true })
		fs.mkdirSync(commandOutputDir, { recursive: true })
		fs.writeFileSync(path.join(artifactsDir, "tool-1706119234567.txt"), "spilled tool result")
		fs.writeFileSync(path.join(commandOutputDir, "cmd-1706119234567.txt"), "command output")
	})

	afterEach(() => {
		fs.rmSync(globalStoragePath, { recursive: true, force: true })
	})

	function buildAccess(): TaskLifecycleAccess {
		const access: Partial<TaskLifecycleAccess> = {
			taskId,
			instanceId: "inst-1",
			globalStoragePath,
			abort: false,
			abandoned: false,
			clineMessages: [],
			apiConversationHistory: [],
			providerRef: { deref: () => undefined } as unknown as TaskLifecycleAccess["providerRef"],
			cancelCurrentRequest: vi.fn() as unknown as TaskLifecycleAccess["cancelCurrentRequest"],
			emit: vi.fn() as unknown as TaskLifecycleAccess["emit"],
		}
		return access as TaskLifecycleAccess
	}

	it("keeps spilled artifacts and clears only command output", async () => {
		const lifecycle = new TaskLifecycle(buildAccess())

		lifecycle.dispose()

		// Cleanup is fire-and-forget; give the promise chain a turn to settle.
		await vi.waitFor(() => {
			expect(fs.existsSync(path.join(commandOutputDir, "cmd-1706119234567.txt"))).toBe(false)
		})

		expect(fs.existsSync(artifactsDir)).toBe(true)
		expect(fs.readFileSync(path.join(artifactsDir, "tool-1706119234567.txt"), "utf8")).toBe("spilled tool result")
	})
})
