import { render, screen, fireEvent } from "@testing-library/react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import StorageErrorBanner from "../StorageErrorBanner"

// Mock the vscode API
const mockPostMessage = vi.fn()
vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: (message: any) => mockPostMessage(message),
	},
}))

// Mock the translation hook
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"common:storageError.banner": "Storage error",
				"common:storageError.showLogs": "Show logs",
			}
			return translations[key] || key
		},
	}),
}))

// Mock the extension state (the real context pulls in the whole provider tree)
const mockUseExtensionState = vi.fn()
vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => mockUseExtensionState(),
}))

describe("StorageErrorBanner", () => {
	beforeEach(() => {
		mockPostMessage.mockClear()
	})

	it("renders nothing when no storage error is set", () => {
		mockUseExtensionState.mockReturnValue({ storageErrorMessage: "" })

		const { container } = render(<StorageErrorBanner />)

		expect(container.firstChild).toBeNull()
		expect(screen.queryByText("Storage error")).not.toBeInTheDocument()
	})

	it("renders nothing when the error field is undefined", () => {
		mockUseExtensionState.mockReturnValue({ storageErrorMessage: undefined })

		const { container } = render(<StorageErrorBanner />)

		expect(container.firstChild).toBeNull()
	})

	it("renders the error message and a Show logs button when set", () => {
		mockUseExtensionState.mockReturnValue({
			storageErrorMessage: "TaskHistoryStore: ENOSPC: no space left on device",
		})

		render(<StorageErrorBanner />)

		expect(screen.getByTestId("storage-error-banner")).toBeInTheDocument()
		expect(screen.getByText("Storage error")).toBeInTheDocument()
		expect(screen.getByText("TaskHistoryStore: ENOSPC: no space left on device")).toBeInTheDocument()
		expect(screen.getByText("Show logs")).toBeInTheDocument()
	})

	it("opens the extension logs when the Show logs button is clicked", () => {
		mockUseExtensionState.mockReturnValue({ storageErrorMessage: "TaskHistoryStore: ENOSPC" })

		render(<StorageErrorBanner />)

		fireEvent.click(screen.getByText("Show logs"))

		expect(mockPostMessage).toHaveBeenCalledWith({ type: "openExtensionLogs" })
	})
})
