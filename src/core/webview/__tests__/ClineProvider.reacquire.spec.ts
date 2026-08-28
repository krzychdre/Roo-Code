// pnpm --filter tumble-code test core/webview/__tests__/ClineProvider.reacquire.spec.ts

import * as vscode from "vscode"
import type { ExtensionState } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { ContextProxy } from "../../config/ContextProxy"
import { ClineProvider } from "../ClineProvider"
import { TaskHistoryStore, type TaskHistoryStoreHandle } from "../../task-persistence"

// Mock setup (mirrors ClineProvider.storageError.spec.ts)
vi.mock("p-wait-for", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" })),
	readdir: vi.fn().mockResolvedValue([]),
	unlink: vi.fn().mockResolvedValue(undefined),
	rmdir: vi.fn().mockResolvedValue(undefined),
	access: vi.fn().mockResolvedValue(undefined),
	rm: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("axios", () => ({
	default: {
		get: vi.fn().mockResolvedValue({ data: { data: [] } }),
		post: vi.fn(),
	},
	get: vi.fn().mockResolvedValue({ data: { data: [] } }),
	post: vi.fn(),
}))

vi.mock("delay", () => {
	const delayFn = (_ms: number) => Promise.resolve()
	delayFn.createDelay = () => delayFn
	delayFn.reject = () => Promise.reject(new Error("Delay rejected"))
	delayFn.range = () => Promise.resolve()
	return { default: delayFn }
})

vi.mock("../../prompts/sections/custom-instructions")

vi.mock("../../../utils/storage", () => ({
	getSettingsDirectoryPath: vi.fn().mockResolvedValue("/test/settings/path"),
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/task/path"),
	getGlobalStoragePath: vi.fn().mockResolvedValue("/test/storage/path"),
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

vi.mock("../../../utils/safeWriteJson", () => {
	const write = vi.fn().mockResolvedValue(undefined)
	return {
		safeWriteJson: write,
		withLockedJsonTransaction: vi.fn(
			async <T>(
				_lockTarget: string,
				_destination: string,
				body: (writeJson: (data: unknown) => Promise<void>) => Promise<T>,
			) => body((data) => write(data)),
		),
	}
})

vi.mock("proper-lockfile", () => ({
	lock: vi.fn(async () => async () => {}),
	unlock: vi.fn(async () => {}),
	check: vi.fn(async () => false),
}))

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
	CallToolResultSchema: {},
	ListResourcesResultSchema: {},
	ListResourceTemplatesResultSchema: {},
	ListToolsResultSchema: {},
	ReadResourceResultSchema: {},
	ErrorCode: {
		InvalidRequest: "InvalidRequest",
		MethodNotFound: "MethodNotFound",
		InternalError: "InternalError",
	},
	McpError: class McpError extends Error {
		code: string
		constructor(code: string, message: string) {
			super(message)
			this.code = code
			this.name = "McpError"
		}
	},
}))

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		listTools: vi.fn().mockResolvedValue({ tools: [] }),
		callTool: vi.fn().mockResolvedValue({ content: [] }),
	})),
}))

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(() => ({
		connect: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
	})),
}))

vi.mock("vscode", () => ({
	ExtensionContext: vi.fn(),
	OutputChannel: vi.fn(),
	WebviewView: vi.fn(),
	Uri: {
		joinPath: vi.fn(),
		file: vi.fn(),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	commands: {
		executeCommand: vi.fn().mockResolvedValue(undefined),
	},
	window: {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	},
	workspace: {
		getConfiguration: vi.fn().mockReturnValue({
			get: vi.fn().mockReturnValue([]),
			update: vi.fn(),
		}),
		onDidChangeConfiguration: vi.fn().mockImplementation(() => ({
			dispose: vi.fn(),
		})),
		onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
		onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
	},
	env: {
		uriScheme: "vscode",
		language: "en",
		appName: "Visual Studio Code",
	},
	ExtensionMode: {
		Production: 1,
		Development: 2,
		Test: 3,
	},
	version: "1.85.0",
}))

vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn().mockReturnValue({
		getModel: vi.fn().mockReturnValue({
			id: "claude-3-sonnet",
		}),
	}),
}))

vi.mock("../../prompts/system", () => ({
	SYSTEM_PROMPT: vi.fn().mockImplementation(async () => "mocked system prompt"),
	codeMode: "code",
}))

vi.mock("../../../integrations/workspace/WorkspaceTracker", () => {
	return {
		default: vi.fn().mockImplementation(() => ({
			initializeFilePaths: vi.fn(),
			dispose: vi.fn(),
		})),
	}
})

vi.mock("../../task/Task", () => ({
	Task: vi.fn().mockImplementation((options: any) => ({
		api: undefined,
		abortTask: vi.fn(),
		handleWebviewAskResponse: vi.fn(),
		clineMessages: [],
		apiConversationHistory: [],
		overwriteClineMessages: vi.fn(),
		overwriteApiConversationHistory: vi.fn(),
		getTaskNumber: vi.fn().mockReturnValue(0),
		setTaskNumber: vi.fn(),
		setParentTask: vi.fn(),
		setRootTask: vi.fn(),
		taskId: options?.historyItem?.id || "test-task-id",
		emit: vi.fn(),
	})),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("file content"),
}))

vi.mock("../../../api/providers/fetchers/modelCache", () => ({
	getModels: vi.fn().mockResolvedValue({}),
	flushModels: vi.fn(),
	getModelsFromCache: vi.fn().mockReturnValue(undefined),
}))

vi.mock("../../../shared/modes", () => ({
	modes: [{ slug: "code", name: "Code Mode", roleDefinition: "You are a code assistant", groups: ["read", "edit"] }],
	getModeBySlug: vi.fn().mockReturnValue({
		slug: "code",
		name: "Code Mode",
		roleDefinition: "You are a code assistant",
		groups: ["read", "edit"],
	}),
	getGroupName: vi.fn().mockReturnValue("General Tools"),
	defaultModeSlug: "code",
}))

vi.mock("../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn().mockImplementation(() => ({
		getName: () => "test-strategy",
		applyDiff: vi.fn(),
	})),
}))

vi.mock("@roo-code/cloud", () => ({
	CloudService: {
		hasInstance: vi.fn().mockReturnValue(true),
		get instance() {
			return {
				isAuthenticated: vi.fn().mockReturnValue(false),
				getAllowList: vi.fn().mockResolvedValue("*"),
				getUserInfo: vi.fn().mockReturnValue(null),
				canShareTask: vi.fn().mockResolvedValue(false),
				canSharePublicly: vi.fn().mockResolvedValue(false),
				getOrganizationSettings: vi.fn().mockReturnValue(null),
				getOrganizationMemberships: vi.fn().mockResolvedValue([]),
				getUserSettings: vi.fn().mockReturnValue(null),
				isTaskSyncEnabled: vi.fn().mockReturnValue(false),
				on: vi.fn(),
				off: vi.fn(),
				once: vi.fn(),
				emit: vi.fn(),
				removeAllListeners: vi.fn(),
			}
		},
	},
	getRooCodeApiUrl: vi.fn().mockReturnValue("http://localhost:8080"),
	getRooCodeProviderUrl: vi.fn().mockReturnValue("http://localhost:8080/proxy"),
}))

afterAll(() => {
	vi.restoreAllMocks()
})

describe("ClineProvider TaskHistoryStore reacquire", () => {
	let mockContext: vscode.ExtensionContext
	let mockOutputChannel: vscode.OutputChannel
	let mockWebviewView: vscode.WebviewView
	let mockPostMessage: ReturnType<typeof vi.fn>

	const flush = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

	const deferred = <T>() => {
		let resolve!: (value: T) => void
		let reject!: (reason?: unknown) => void
		const promise = new Promise<T>((res, rej) => {
			resolve = res
			reject = rej
		})
		return { promise, resolve, reject }
	}

	const makeHandle = (): TaskHistoryStoreHandle => {
		const records = new Map<string, any>()
		const store = {
			onChange: vi.fn(() => vi.fn()),
			migrateFromLegacyHistory: vi.fn().mockResolvedValue(true),
			get: vi.fn((id: string) => records.get(id)),
			getAll: vi.fn(() => Array.from(records.values())),
		} as unknown as TaskHistoryStore
		return { store, dispose: vi.fn() }
	}

	const pushedStates = (): ExtensionState[] =>
		mockPostMessage.mock.calls
			.map((call) => call[0])
			.filter((message: any) => message?.type === "state")
			.map((message: any) => message.state as ExtensionState)

	const waitForStatePush = async (
		predicate: (state: ExtensionState) => boolean,
		timeoutMs = 3000,
	): Promise<ExtensionState[]> => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const found = pushedStates().filter(predicate)
			if (found.length > 0) {
				return found
			}
			await flush(10)
		}
		return pushedStates().filter(predicate)
	}

	beforeEach(() => {
		vi.clearAllMocks()

		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const globalState: Record<string, any> = {
			mode: "code",
			currentApiConfigName: "current-config",
		}

		const secrets: Record<string, string | undefined> = {}

		mockContext = {
			extensionPath: "/test/path",
			extensionUri: {} as vscode.Uri,
			globalState: {
				get: vi.fn().mockImplementation((key: string) => globalState[key]),
				update: vi.fn().mockImplementation((key: string, value: any) => {
					globalState[key] = value
				}),
				keys: vi.fn().mockImplementation(() => Object.keys(globalState)),
			},
			secrets: {
				get: vi.fn().mockImplementation((key: string) => secrets[key]),
				store: vi.fn().mockImplementation((key: string, value: string | undefined) => (secrets[key] = value)),
				delete: vi.fn().mockImplementation((key: string) => delete secrets[key]),
			},
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			subscriptions: [],
			extension: {
				packageJSON: { version: "1.0.0" },
			},
			globalStorageUri: {
				fsPath: "/test/storage/path",
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			clear: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel

		mockPostMessage = vi.fn()

		mockWebviewView = {
			webview: {
				postMessage: mockPostMessage,
				html: "",
				options: {},
				onDidReceiveMessage: vi.fn(),
				asWebviewUri: vi.fn(),
				cspSource: "vscode-webview://test-csp-source",
			},
			visible: true,
			onDidDispose: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
			onDidChangeVisibility: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
		} as unknown as vscode.WebviewView
	})

	afterEach(() => {
		TaskHistoryStore.resetSharedStoresForTests()
	})

	it("rejects once, then retries after the cooldown and clears the reported error", async () => {
		const handle = makeHandle()
		const acquire = vi
			.spyOn(TaskHistoryStore, "acquire")
			.mockRejectedValueOnce(new Error("deterministic acquire failure"))
			.mockResolvedValueOnce(handle)
		const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
		await provider.resolveWebviewView(mockWebviewView).catch(() => {})
		await flush()

		// The eager constructor acquire failed and was reported.
		expect((provider as any).storageErrorMessage).toBe("TaskHistoryStore: deterministic acquire failure")

		// Age out the failure so the next call performs a fresh acquire.
		;(provider as any).taskHistoryStoreLastFailureTs = Date.now() - 6000

		const store = await (provider as any).getTaskHistoryStore()
		expect(store).toBe(handle.store)
		expect((provider as any).storageErrorMessage).toBe("")

		// The webview saw the error appear and then disappear.
		const errorStates = await waitForStatePush(
			(state) => state.storageErrorMessage === "TaskHistoryStore: deterministic acquire failure",
		)
		expect(errorStates.length).toBeGreaterThan(0)
		const clearedStates = await waitForStatePush((state) => state.storageErrorMessage === "")
		expect(clearedStates.length).toBeGreaterThan(0)

		await provider.dispose()
		acquire.mockRestore()
	})

	it("rethrows the remembered error within the cooldown window without a second acquire", async () => {
		const acquire = vi.spyOn(TaskHistoryStore, "acquire").mockRejectedValueOnce(new Error("storage path broken"))
		const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
		await flush()

		// The eager constructor acquire consumed the only mock rejection.
		expect(acquire).toHaveBeenCalledTimes(1)

		// Still inside the cooldown window (real elapsed time is only a few
		// ms): the remembered error is rethrown and no new acquire runs.
		await expect((provider as any).getTaskHistoryStore()).rejects.toThrow("storage path broken")
		await expect((provider as any).getTaskHistoryStore()).rejects.toThrow("storage path broken")
		expect(acquire).toHaveBeenCalledTimes(1)

		await provider.dispose()
		acquire.mockRestore()
	})

	it("degrades getStateToPostToWebview to an empty history instead of throwing", async () => {
		const acquire = vi.spyOn(TaskHistoryStore, "acquire").mockRejectedValue(new Error("storage down"))
		const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))
		await flush()

		const state = await provider.getStateToPostToWebview({ includeTaskHistory: true })
		expect(state.taskHistory).toEqual([])
		expect(state.currentTaskItem).toBeUndefined()
		expect(state.storageErrorMessage).toBe("TaskHistoryStore: storage down")

		// Every failed attempt went through the cooldown, so the store
		// registry was only touched once by the eager constructor acquire.
		expect(acquire).toHaveBeenCalledTimes(1)

		await provider.dispose()
		acquire.mockRestore()
	})

	it("shares one acquire promise between parallel callers", async () => {
		const pending = deferred<TaskHistoryStoreHandle>()
		const handle = makeHandle()
		const acquire = vi.spyOn(TaskHistoryStore, "acquire").mockReturnValueOnce(pending.promise)
		const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		// Three parallel callers (including the eager constructor acquire)
		// must share a single acquire attempt.
		const first = (provider as any).getTaskHistoryStore()
		const second = (provider as any).getTaskHistoryStore()
		const third = provider.getTaskHistory()

		pending.resolve(handle)
		const [store1, store2, history] = await Promise.all([first, second, third])

		expect(acquire).toHaveBeenCalledTimes(1)
		expect(store1).toBe(handle.store)
		expect(store2).toBe(handle.store)
		expect(history).toEqual([])

		await provider.dispose()
		acquire.mockRestore()
	})

	it("releases a store resolved after dispose without subscribing", async () => {
		const pending = deferred<TaskHistoryStoreHandle>()
		const handle = makeHandle()
		const acquire = vi.spyOn(TaskHistoryStore, "acquire").mockReturnValueOnce(pending.promise)
		const provider = new ClineProvider(mockContext, mockOutputChannel, "sidebar", new ContextProxy(mockContext))

		await provider.dispose()
		pending.resolve(handle)

		await vi.waitFor(() => expect(handle.dispose).toHaveBeenCalledTimes(1))
		expect(handle.store.onChange).not.toHaveBeenCalled()

		acquire.mockRestore()
	})
})
