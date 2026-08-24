import type { ClineSayTool } from "@roo-code/types"

export function isWriteToolAction(tool: ClineSayTool): boolean {
	return ["editedExistingFile", "appliedDiff", "newFileCreated", "generateImage"].includes(tool.tool)
}

export function isReadOnlyToolAction(tool: ClineSayTool): boolean {
	return [
		"readFile",
		"listFiles",
		"listFilesTopLevel",
		"listFilesRecursive",
		"searchFiles",
		"codebaseSearch",
		"runSlashCommand",
		// The web tools only read remote pages; they cannot touch the
		// workspace, so they ride the read-only auto-approve category.
		"webSearch",
		"webFetch",
	].includes(tool.tool)
}
