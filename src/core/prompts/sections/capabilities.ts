import { McpHub } from "../../../services/mcp/McpHub"

/**
 * Builds the CAPABILITIES section of the system prompt.
 *
 * KV-cache contract (WS-F): this section belongs to the STABLE HEAD. Its only
 * variable input is `cwd`, which is fixed for a workspace, so the bytes are
 * identical across every mode and every profile in that workspace. The MCP
 * availability sentence used to live here, but it varies with the mode's MCP
 * allowlist, so it moved to {@link getMcpAvailabilitySection} in the variable
 * tail. Nothing mode-dependent may be added back here.
 */
export function getCapabilitiesSection(cwd: string): string {
	// `toPosix()` for consistency with RULES and SYSTEM INFORMATION, which both
	// already normalize the workspace path. Without it a Windows user reads the
	// same directory spelled two ways in one prompt, with backslashes here and
	// forward slashes there, which is exactly the kind of contradiction a weak
	// model resolves by inventing a third spelling. No effect on posix hosts.
	const workspacePath = cwd.toPosix()

	return `====

CAPABILITIES

- You have access to tools that let you execute CLI commands on the user's computer, list files, view source code definitions, regex search, read and write files, and ask follow-up questions. These tools help you effectively accomplish a wide range of tasks, such as writing code, making edits or improvements to existing files, understanding the current state of a project, performing system operations, and much more.
- When the user initially gives you a task, a recursive list of all filepaths in the current workspace directory ('${workspacePath}') will be included in environment_details. This provides an overview of the project's file structure, offering key insights into the project from directory/file names (how developers conceptualize and organize their code) and file extensions (the language used). This can also guide decision-making on which files to explore further. If you need to further explore directories such as outside the current workspace directory, you can use the list_files tool. If you pass 'true' for the recursive parameter, it will list files recursively. Otherwise, it will list files at the top level, which is better suited for generic directories where you don't necessarily need the nested structure, like the Desktop.
- You can use the execute_command tool to run commands on the user's computer whenever you feel it can help accomplish the user's task. When you need to execute a CLI command, you must provide a clear explanation of what the command does. Prefer to execute complex CLI commands over creating executable scripts, since they are more flexible and easier to run. Interactive and long-running commands are allowed, since the commands are run in the user's VSCode terminal. The user may keep commands running in the background and you will be kept updated on their status along the way. Each command you execute is run in a new terminal instance.`
}

/**
 * Builds the MCP SERVERS availability section (variable tail).
 *
 * The sentence is only emitted when at least one MCP server is actually exposed
 * to the current mode. When `allowedMcpServers` is provided, the hub's server
 * list is filtered by that allowlist BEFORE deciding whether to advertise MCP,
 * so the text matches the per-mode tool exposure:
 *   - `undefined` allowlist  -> all connected servers count (backward compatible)
 *   - empty `[]` allowlist   -> no servers count, section omitted
 *   - populated allowlist    -> only listed servers count
 *
 * This lives in the tail rather than in CAPABILITIES because two modes on the
 * same workspace can disagree about it (one carries the `mcp` group, the other
 * does not), and a byte that differs per mode must never sit in the shared
 * prefix. Callers pass `undefined` for the hub when the mode has no MCP group.
 */
export function getMcpAvailabilitySection(mcpHub?: McpHub, allowedMcpServers?: string[]): string {
	// Determine whether any MCP server is actually available to the current mode.
	let hasMcpServers = false
	if (mcpHub) {
		let servers = mcpHub.getServers()
		if (allowedMcpServers) {
			const allowSet = new Set(allowedMcpServers)
			servers = servers.filter((server) => allowSet.has(server.name))
		}
		hasMcpServers = servers.length > 0
	}

	if (!hasMcpServers) {
		return ""
	}

	return `====

MCP SERVERS

You have access to MCP servers that may provide additional tools and resources. Each server may provide different capabilities that you can use to accomplish tasks more effectively.`
}
