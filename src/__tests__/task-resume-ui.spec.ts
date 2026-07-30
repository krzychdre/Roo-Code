// npx vitest run __tests__/task-resume-ui.spec.ts

import { describe, it, expect, vi } from "vitest"
import { ClineProvider } from "../core/webview/ClineProvider"

vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const env = {
		machineId: "test-machine",
		uriScheme: "vscode",
		appName: "VSCode",
		language: "en",
		sessionId: "sess",
	}
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2, Test: 3 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

vi.mock("../core/task/Task", () => {
	class TaskStub {
		public taskId: string
		public instanceId = "inst"
		public parentTask?: any
		public rootTask?: any
		public apiConfiguration: any
		public clineMessages: any[] = []
		constructor(opts: any) {
			this.taskId = opts.historyItem?.id ?? `task-${Math.random().toString(36).slice(2, 8)}`
			this.parentTask = opts.parentTask
			this.rootTask = opts.rootTask
			this.apiConfiguration = opts.apiConfiguration ?? { apiProvider: "anthropic" }
			opts.onCreated?.(this)
		}
		start() {}
		on() {}
		off() {}
		emit() {}
	}
	return { Task: TaskStub }
})

vi.mock("../core/prompts/sections/custom-instructions")
vi.mock("../utils/safeWriteJson", () => {
	const write = vi.fn().mockResolvedValue(undefined)
	return {
		safeWriteJson: write,
		withLockedJsonTransaction: vi.fn(
			async <T>(
				_lockTarget: string,
				destination: string,
				body: (writeJson: (data: unknown) => Promise<void>) => Promise<T>,
			) => body((data) => write(destination, data)),
		),
	}
})

// The JSON transaction gateway is mocked above; keep proper-lockfile inert for
// unrelated safe-write call sites in these UI specs.
vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
	unlock: vi.fn(async () => {}),
	check: vi.fn(async () => false),
}))
vi.mock("../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({ id: "claude-3-sonnet" }),
	}),
}))
vi.mock("../integrations/workspace/WorkspaceTracker", () => ({
	default: vi.fn().mockImplementation(() => ({
		initializeFilePaths: vi.fn(),
		dispose: vi.fn(),
	})),
}))
vi.mock("../core/diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(() => ({
		getName: () => "test-strategy",
		applyDiff: vi.fn(),
	})),
}))
vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return { isAuthenticated: vi.fn().mockReturnValue(false) }
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("http://localhost:8080"),
}))
vi.mock("../shared/modes", () => ({
	modes: [{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", groups: ["read", "edit"] }],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	defaultModeSlug: "code",
}))
vi.mock("../core/prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockResolvedValue("mocked system prompt"),
	codeMode: "code",
}))
vi.mock("../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))
vi.mock("../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))
vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))
vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue("[]"),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../utils/storage", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../utils/storage")>()
	return {
		...actual,
		getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
		getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
		getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	}
})
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				trackEvent: vi.fn(),
				trackError: vi.fn(),
				setProvider: vi.fn(),
				captureModeSwitch: vi.fn(),
				captureTaskRestarted: vi.fn(),
				captureTaskCreated: vi.fn(),
			}
		},
	},
}))

function makeProvider(overrides: Record<string, any> = {}) {
	return {
		getCurrentTask: vi.fn(() => undefined),
		removeClineFromStack: vi.fn().mockResolvedValue(undefined),
		addClineToStack: vi.fn().mockResolvedValue(undefined),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		updateGlobalState: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
		customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
		providerSettingsManager: {
			getModeConfigId: vi.fn().mockResolvedValue(undefined),
			listConfig: vi.fn().mockResolvedValue([]),
		},
		getState: vi.fn().mockResolvedValue({
			apiConfiguration: { apiProvider: "anthropic", consecutiveMistakeLimit: 0 },
			enableCheckpoints: true,
			checkpointTimeout: 60,
			experiments: {},
			cloudUserInfo: null,
			taskSyncEnabled: false,
		}),
		getPendingEditOperation: vi.fn().mockReturnValue(undefined),
		clearPendingEditOperation: vi.fn(),
		performPreparationTasks: vi.fn().mockResolvedValue(undefined),
		context: { extension: { packageJSON: {} }, globalStorageUri: { fsPath: "/tmp" } },
		contextProxy: {
			extensionUri: {},
			getValue: vi.fn(),
			setValue: vi.fn(),
			setProviderSettings: vi.fn(),
			getProviderSettings: vi.fn(() => ({})),
		},
		clineStack: [],
		taskEventListeners: new Map(),
		// The real method rather than a stub. The history items these tests use
		// carry no `parallelChildIds`, so it returns at its first guard and
		// touches nothing — while a double that has drifted from the class
		// still fails here loudly instead of at "is not a function".
		rehydrateSubagents: (ClineProvider.prototype as any).rehydrateSubagents,
		postMessageToWebview: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as ClineProvider
}

const baseHistoryItem = {
	id: "hist-1",
	number: 1,
	ts: Date.now(),
	task: "Task",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	workspace: "/tmp",
}

describe("createTaskWithHistoryItem – eager state push", () => {
	it("calls postStateToWebview after adding task to stack", async () => {
		const provider = makeProvider()

		await (ClineProvider.prototype as any).createTaskWithHistoryItem.call(provider, { ...baseHistoryItem })

		expect((provider as any).postStateToWebview).toHaveBeenCalledTimes(1)
	})

	it("calls postStateToWebview after rehydrating current task in-place", async () => {
		const existingTask = {
			taskId: "hist-1",
			instanceId: "old-inst",
			abortTask: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
			off: vi.fn(),
			emit: vi.fn(),
		}

		const provider = makeProvider({
			getCurrentTask: vi.fn(() => existingTask),
			clineStack: [existingTask],
			taskEventListeners: new Map([[existingTask, [vi.fn()]]]),
		})

		await (ClineProvider.prototype as any).createTaskWithHistoryItem.call(provider, { ...baseHistoryItem })

		expect((provider as any).postStateToWebview).toHaveBeenCalledTimes(1)
	})
})

describe("showTaskWithId – rootTask/parentTask resolution", () => {
	it("passes rootTask and parentTask from clineStack when resuming a subtask", async () => {
		const rootTask = { taskId: "root-1", on: vi.fn(), off: vi.fn(), emit: vi.fn() }
		const parentTask = { taskId: "parent-1", on: vi.fn(), off: vi.fn(), emit: vi.fn() }

		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		const provider = makeProvider({
			getCurrentTask: vi.fn(() => ({ taskId: "other-task" })),
			clineStack: [rootTask, parentTask],
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					...baseHistoryItem,
					id: "subtask-1",
					rootTaskId: "root-1",
					parentTaskId: "parent-1",
				},
			}),
			createTaskWithHistoryItem,
		})

		await (ClineProvider.prototype as any).showTaskWithId.call(provider, "subtask-1")

		expect(createTaskWithHistoryItem).toHaveBeenCalledTimes(1)
		const callArgs = createTaskWithHistoryItem.mock.calls[0][0]
		expect(callArgs.rootTask).toBe(rootTask)
		expect(callArgs.parentTask).toBe(parentTask)
	})

	it("passes undefined rootTask/parentTask when IDs are not in clineStack", async () => {
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		const provider = makeProvider({
			getCurrentTask: vi.fn(() => ({ taskId: "other-task" })),
			clineStack: [],
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: {
					...baseHistoryItem,
					id: "subtask-1",
					rootTaskId: "root-1",
					parentTaskId: "parent-1",
				},
			}),
			createTaskWithHistoryItem,
		})

		await (ClineProvider.prototype as any).showTaskWithId.call(provider, "subtask-1")

		expect(createTaskWithHistoryItem).toHaveBeenCalledTimes(1)
		const callArgs = createTaskWithHistoryItem.mock.calls[0][0]
		expect(callArgs.rootTask).toBeUndefined()
		expect(callArgs.parentTask).toBeUndefined()
	})

	it("skips createTaskWithHistoryItem when clicking the current task", async () => {
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		const provider = makeProvider({
			getCurrentTask: vi.fn(() => ({ taskId: "current-1" })),
			createTaskWithHistoryItem,
		})

		await (ClineProvider.prototype as any).showTaskWithId.call(provider, "current-1")

		expect(createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect((provider as any).postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
		})
	})

	it("always sends chatButtonClicked after switching tasks", async () => {
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		const provider = makeProvider({
			getCurrentTask: vi.fn(() => ({ taskId: "other-task" })),
			clineStack: [],
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: { ...baseHistoryItem, id: "task-1" },
			}),
			createTaskWithHistoryItem,
		})

		await (ClineProvider.prototype as any).showTaskWithId.call(provider, "task-1")

		expect((provider as any).postMessageToWebview).toHaveBeenCalledWith({
			type: "action",
			action: "chatButtonClicked",
		})
	})

	it("does not set rootTask/parentTask for top-level tasks without parent IDs", async () => {
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue({})
		const provider = makeProvider({
			getCurrentTask: vi.fn(() => ({ taskId: "other-task" })),
			clineStack: [],
			getTaskWithId: vi.fn().mockResolvedValue({
				historyItem: { ...baseHistoryItem, id: "top-level-1" },
			}),
			createTaskWithHistoryItem,
		})

		await (ClineProvider.prototype as any).showTaskWithId.call(provider, "top-level-1")

		expect(createTaskWithHistoryItem).toHaveBeenCalledTimes(1)
		const callArgs = createTaskWithHistoryItem.mock.calls[0][0]
		expect(callArgs.rootTask).toBeUndefined()
		expect(callArgs.parentTask).toBeUndefined()
	})
})
