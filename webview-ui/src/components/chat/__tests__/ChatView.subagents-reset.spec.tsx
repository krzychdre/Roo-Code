// pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/ChatView.subagents-reset.spec.tsx
//
// Verifies the webview side of the subagent lifecycle fix (Part A): a new
// chat (invoke: "newChat") drives `handleChatReset`, which calls
// `clearSubagents` so the subagents slice is emptied and a new task never
// inherits the previous task's subagent rows.
//
// This test renders ChatView inside the real ExtensionStateContextProvider
// and drives the SAME message path the extension host uses (`invoke:
// "newChat"`). A probe component reads the `subagents` slice directly from
// context so the assertion does not depend on the SubagentsPanel render
// tree (which requires many unrelated mocks and is covered separately by
// SubagentsPanel tests).

import React from "react"
import { render, screen, act, waitFor } from "@/utils/test-utils"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExtensionStateContextProvider, useExtensionState } from "@src/context/ExtensionStateContext"

import ChatView, { ChatViewProps } from "../ChatView"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

const mockPlayFunction = vi.fn()
vi.mock("use-sound", () => ({
	default: vi.fn().mockImplementation(() => [mockPlayFunction]),
}))

vi.mock("../ChatRow", () => ({
	default: function MockChatRow({ message }: { message: { ts: number } }) {
		return <div data-testid="chat-row">{JSON.stringify(message)}</div>
	},
}))

vi.mock("../AutoApproveMenu", () => ({
	default: () => null,
}))

vi.mock("react-virtuoso", () => ({
	Virtuoso: function MockVirtuoso({
		data,
		itemContent,
	}: {
		data: { ts: number }[]
		itemContent: (index: number, item: { ts: number }) => React.ReactNode
	}) {
		return (
			<div data-testid="virtuoso-item-list">
				{data.map((item, index) => (
					<div key={item.ts} data-testid={`virtuoso-item-${index}`}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		)
	},
}))

vi.mock("../../common/VersionIndicator", () => ({
	default: vi.fn(() => null),
}))

vi.mock("@src/components/welcome/RooTips", () => ({
	default: () => <div data-testid="roo-tips">Tips content</div>,
}))

vi.mock("@src/components/welcome/RooHero", () => ({
	default: () => <div data-testid="roo-hero">Hero content</div>,
}))

vi.mock("../common/TelemetryBanner", () => ({
	default: () => null,
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) => key,
	}),
	initReactI18next: {
		type: "3rdParty",
		init: () => {},
	},
	Trans: ({ i18nKey, children }: { i18nKey: string; children?: React.ReactNode }) => <>{children || i18nKey}</>,
}))

const defaultProps: ChatViewProps = {
	isHidden: false,
	showAnnouncement: false,
	hideAnnouncement: () => {},
}

const queryClient = new QueryClient()

/** Probe that reads the subagents slice directly from context. */
const SubagentsProbe = () => {
	const { subagents } = useExtensionState()
	return <div data-testid="subagents-probe">{JSON.stringify(subagents)}</div>
}

const renderChatView = (props: Partial<ChatViewProps> = {}) =>
	render(
		<ExtensionStateContextProvider>
			<QueryClientProvider client={queryClient}>
				<ChatView {...defaultProps} {...props} />
				<SubagentsProbe />
			</QueryClientProvider>
		</ExtensionStateContextProvider>,
	)

const postExtensionMessage = (payload: Record<string, unknown>) => {
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: payload }))
	})
}

const readSubagents = () => JSON.parse(screen.getByTestId("subagents-probe").textContent!)

describe("ChatView — subagents reset on new chat (Part A webview side)", () => {
	it("handleChatReset clears the subagents slice when invoke: newChat arrives", async () => {
		renderChatView()

		// Seed a populated subagents panel (unscoped push is accepted
		// unconditionally — see ExtensionStateContext.subagents.spec.tsx).
		postExtensionMessage({
			type: "subagentsUpdated",
			subagents: [
				{
					taskId: "child-1",
					parentTaskId: "parent-1",
					index: 0,
					mode: "code",
					description: "do thing",
					status: "completed",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					startedAt: 1,
					lastActivityAt: 2,
				},
				{
					taskId: "child-2",
					parentTaskId: "parent-1",
					index: 1,
					mode: "ask",
					description: "do other thing",
					status: "failed",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					startedAt: 1,
					lastActivityAt: 2,
				},
			],
		})

		await waitFor(() => {
			expect(readSubagents()).toHaveLength(2)
		})

		// Trigger handleChatReset via the same message path the extension
		// uses when the user starts a new task (newChat invoke).
		postExtensionMessage({
			type: "invoke",
			invoke: "newChat",
		})

		// The subagents slice is cleared by clearSubagents() inside
		// handleChatReset; a new task never inherits the previous task's
		// subagent rows.
		await waitFor(() => {
			expect(readSubagents()).toEqual([])
		})
	})

	it("handleChatReset is a no-op for the subagents slice when it is already empty", async () => {
		renderChatView()

		// No subagents seeded; the slice is empty.
		expect(readSubagents()).toEqual([])

		// Trigger handleChatReset; the slice stays empty (no crash).
		postExtensionMessage({
			type: "invoke",
			invoke: "newChat",
		})

		await waitFor(() => {
			expect(readSubagents()).toEqual([])
		})
	})
})
