/* eslint-disable @typescript-eslint/no-explicit-any */

// npx vitest run src/__tests__/TelemetryClient.sideCalls.spec.ts

import { type TelemetryPropertiesProvider, TelemetryEventName } from "@roo-code/types"

import { CloudTelemetryClient as TelemetryClient } from "../TelemetryClient.js"

/**
 * The payload is posted as `rooCodeTelemetryEventSchema.safeParse(...).data`, and
 * Zod drops keys the schema does not declare. That is how 16 393 `Tool Used`
 * rows ended up with no `tool` on the live deployment. These tests pin the
 * properties the usage metrics depend on to the wire, so an undeclared field
 * fails here instead of silently vanishing between the extension and the
 * database.
 */

const mockFetch = vi.fn()
global.fetch = mockFetch as any

const PROVIDER_PROPERTIES = {
	appName: "roo-code",
	appVersion: "1.0.0",
	vscodeVersion: "1.60.0",
	platform: "darwin",
	editorName: "vscode",
	language: "en",
	mode: "code",
	// What the provider believes is current — deliberately not the model a side
	// call runs on.
	modelId: "the-open-task-model",
}

function sentBody(): any {
	const [, options] = mockFetch.mock.calls.at(-1)!
	return JSON.parse(options.body)
}

describe("TelemetryClient — usage from calls off the main loop", () => {
	let client: TelemetryClient

	beforeEach(() => {
		vi.clearAllMocks()

		const authService: any = {
			getSessionToken: vi.fn().mockReturnValue("mock-token"),
			getState: vi.fn().mockReturnValue("active-session"),
			isAuthenticated: vi.fn().mockReturnValue(true),
			hasActiveSession: vi.fn().mockReturnValue(true),
		}
		const settingsService: any = {
			getSettings: vi.fn().mockReturnValue({ cloudSettings: { recordTaskMessages: true } }),
			getUserSettings: vi.fn().mockReturnValue({ features: {}, settings: {} }),
			isTaskSyncEnabled: vi.fn().mockReturnValue(true),
		}

		mockFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) })

		client = new TelemetryClient(authService, settingsService)
		const provider: TelemetryPropertiesProvider = {
			getTelemetryProperties: vi.fn().mockResolvedValue(PROVIDER_PROPERTIES),
		}
		client.setProvider(provider)
	})

	it("keeps completionKind on the wire", async () => {
		await client.capture({
			event: TelemetryEventName.LLM_COMPLETION,
			properties: {
				taskId: "task-1",
				inputTokens: 100,
				outputTokens: 10,
				completionKind: "condense",
				usageReported: true,
			},
		})

		expect(sentBody().properties.completionKind).toBe("condense")
		expect(sentBody().properties.usageReported).toBe(true)
	})

	it("lets a side call state its own model, overriding the open task's", async () => {
		await client.capture({
			event: TelemetryEventName.LLM_COMPLETION,
			properties: {
				taskId: "task-1",
				inputTokens: 100,
				outputTokens: 10,
				completionKind: "enhance",
				modelId: "the-enhancement-model",
			},
		})

		expect(sentBody().properties.modelId).toBe("the-enhancement-model")
	})

	it("still accepts a completion that names no kind — every stored row predates it", async () => {
		await client.capture({
			event: TelemetryEventName.LLM_COMPLETION,
			properties: { taskId: "task-1", inputTokens: 100, outputTokens: 10 },
		})

		expect(mockFetch).toHaveBeenCalled()
		expect(sentBody().properties.completionKind).toBeUndefined()
	})

	it("rejects a kind that is not one of the four", async () => {
		await client.capture({
			event: TelemetryEventName.LLM_COMPLETION,
			properties: {
				taskId: "task-1",
				inputTokens: 1,
				outputTokens: 1,
				completionKind: "something-invented",
			},
		})

		expect(mockFetch).not.toHaveBeenCalled()
	})

	it("sends embedding usage as its own event, with its token figures intact", async () => {
		await client.capture({
			event: TelemetryEventName.EMBEDDING_USAGE,
			properties: { promptTokens: 128_000, totalTokens: 128_000, source: "index-scan" },
		})

		const body = sentBody()
		expect(body.type).toBe("Embedding Usage")
		expect(body.properties.promptTokens).toBe(128_000)
		expect(body.properties.source).toBe("index-scan")
	})
})
