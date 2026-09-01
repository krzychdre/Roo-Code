// npx vitest run core/webview/__tests__/webviewMessageHandler.storageErrorToast.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { webviewMessageHandler } from "../webviewMessageHandler"
import * as vscode from "vscode"
import type { ClineProvider } from "../ClineProvider"

// Mock the i18n module (keys are passed through, assertions focus on the
// appended cause).
vi.mock("../../../i18n", () => ({
	t: vi.fn((key: string) => key),
	changeLanguage: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
	},
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
			update: vi.fn(),
		})),
	},
	commands: {
		executeCommand: vi.fn(),
	},
}))

const showErrorMessage = vi.mocked(vscode.window.showErrorMessage)

const makeProvider = (overrides: Partial<Record<string, any>> = {}): ClineProvider => {
	return {
		log: vi.fn(),
		postMessageToWebview: vi.fn(),
		postStateToWebview: vi.fn(),
		providerSettingsManager: {
			saveConfig: vi.fn(),
			listConfig: vi.fn().mockResolvedValue([]),
			getProfile: vi.fn(),
			deleteConfig: vi.fn(),
		},
		activateProviderProfile: vi.fn(),
		upsertProviderProfile: vi.fn(),
		showOutputChannel: vi.fn(),
		...overrides,
	} as unknown as ClineProvider
}

describe("webviewMessageHandler - error toasts carry the underlying cause", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("saveApiConfiguration toast contains the failure message", async () => {
		const provider = makeProvider({
			providerSettingsManager: {
				saveConfig: vi.fn().mockRejectedValue(new Error("disk full")),
				listConfig: vi.fn().mockResolvedValue([]),
				getProfile: vi.fn(),
				deleteConfig: vi.fn(),
			},
		})

		await webviewMessageHandler(provider, {
			type: "saveApiConfiguration",
			text: "profile-1",
			apiConfiguration: {} as any,
		})

		expect(showErrorMessage).toHaveBeenCalledTimes(1)
		const toast = showErrorMessage.mock.calls[0][0]
		expect(toast).toContain("common:errors.save_api_config")
		expect(toast).toContain("disk full")
	})

	it("renameApiConfiguration toast contains the failure message", async () => {
		const provider = makeProvider({
			providerSettingsManager: {
				saveConfig: vi.fn(),
				listConfig: vi.fn().mockResolvedValue([]),
				getProfile: vi.fn().mockRejectedValue(new Error("profile locked")),
				deleteConfig: vi.fn(),
			},
		})

		await webviewMessageHandler(provider, {
			type: "renameApiConfiguration",
			values: { oldName: "old", newName: "new" },
			apiConfiguration: {} as any,
		})

		expect(showErrorMessage).toHaveBeenCalledTimes(1)
		const toast = showErrorMessage.mock.calls[0][0]
		expect(toast).toContain("common:errors.rename_api_config")
		expect(toast).toContain("profile locked")
	})

	it("loadApiConfiguration toast contains the failure message", async () => {
		const provider = makeProvider({
			activateProviderProfile: vi.fn().mockRejectedValue(new Error("secret storage unavailable")),
		})

		await webviewMessageHandler(provider, { type: "loadApiConfiguration", text: "profile-1" })

		expect(showErrorMessage).toHaveBeenCalledTimes(1)
		const toast = showErrorMessage.mock.calls[0][0]
		expect(toast).toContain("common:errors.load_api_config")
		expect(toast).toContain("secret storage unavailable")
	})

	it("loadApiConfigurationById toast contains the failure message", async () => {
		const provider = makeProvider({
			activateProviderProfile: vi.fn().mockRejectedValue(new Error("read-only file system")),
		})

		await webviewMessageHandler(provider, { type: "loadApiConfigurationById", text: "config-123" })

		expect(showErrorMessage).toHaveBeenCalledTimes(1)
		const toast = showErrorMessage.mock.calls[0][0]
		expect(toast).toContain("common:errors.load_api_config")
		expect(toast).toContain("read-only file system")
	})

	it("showTaskWithId toast contains the failure message", async () => {
		const provider = makeProvider({
			showTaskWithId: vi.fn().mockRejectedValue(new Error("Task not found")),
		})

		await webviewMessageHandler(provider, { type: "showTaskWithId", text: "task-1" })
		// showTaskWithId failures are handled in a floating .catch; let the
		// microtask queue settle before asserting.
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(showErrorMessage).toHaveBeenCalledTimes(1)
		const toast = showErrorMessage.mock.calls[0][0]
		expect(toast).toContain("common:errors.task_show_failed")
		expect(toast).toContain("Task not found")
	})
})
