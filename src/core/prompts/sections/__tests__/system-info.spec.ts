import os from "os"

// Mock the modules - must be hoisted before imports
vi.mock("os-name", () => ({
	default: vi.fn(),
}))

vi.mock("../../../../utils/shell", () => ({
	getShell: vi.fn(() => "/bin/bash"),
}))

import { getSystemInfoSection, resetOsInfoCacheForTests } from "../system-info"
import osName from "os-name"

const mockOsName = osName as unknown as ReturnType<typeof vi.fn>

describe("getSystemInfoSection", () => {
	const mockCwd = "/test/workspace"
	const mockHomeDir = "/home/user"

	beforeEach(() => {
		// The OS name is memoized per process; each test wants its own os-name
		// behavior observed.
		resetOsInfoCacheForTests()
		vi.spyOn(os, "homedir").mockReturnValue(mockHomeDir)
		vi.spyOn(os, "platform").mockReturnValue("linux" as any)
		vi.spyOn(os, "release").mockReturnValue("5.15.0")
	})

	afterEach(() => {
		vi.clearAllMocks()
	})

	it("should return system info with os-name when available", () => {
		mockOsName.mockReturnValue("Ubuntu 22.04")

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: Ubuntu 22.04")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should fallback to platform and release when os-name throws error", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: linux 5.15.0")
		expect(result).toContain("Default Shell: /bin/bash")
		expect(result).toContain(`Home Directory: ${mockHomeDir}`)
		expect(result).toContain(`Current Workspace Directory: ${mockCwd}`)
	})

	it("should handle Windows platform in fallback", () => {
		mockOsName.mockImplementation(() => {
			throw new Error("Command failed with ENOENT: powershell")
		})
		vi.spyOn(os, "platform").mockReturnValue("win32" as any)
		vi.spyOn(os, "release").mockReturnValue("10.0.19043")

		const result = getSystemInfoSection(mockCwd)

		expect(result).toContain("Operating System: win32 10.0.19043")
	})

	it("resolves the OS name once per process, not on every prompt build", () => {
		mockOsName.mockReturnValue("Windows Server 2025")

		getSystemInfoSection(mockCwd)
		const second = getSystemInfoSection(mockCwd)

		expect(mockOsName).toHaveBeenCalledTimes(1)
		expect(second).toContain("Operating System: Windows Server 2025")
	})
})
