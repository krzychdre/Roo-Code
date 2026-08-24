import type OpenAI from "openai"
import { McpHub } from "../../../../services/mcp/McpHub"
import { buildMcpToolName } from "../../../../utils/mcp-name"
import { normalizeToolSchema, type JsonSchema } from "../../../../utils/json-schema"

/**
 * Dynamically generates native tool definitions for all enabled tools across connected MCP servers.
 * Tools are deduplicated by name to prevent API errors. When the same server exists in both
 * global and project configs, project servers take priority (handled by McpHub.getServers()).
 *
 * @param mcpHub The McpHub instance containing connected servers.
 * @returns An array of OpenAI.Chat.ChatCompletionTool definitions.
 */
export function getMcpServerTools(mcpHub?: McpHub, allowedServers?: string[]): OpenAI.Chat.ChatCompletionTool[] {
	if (!mcpHub) {
		return []
	}

	let servers = mcpHub.getServers()

	// Filter servers by allowlist if provided
	if (allowedServers) {
		const allowSet = new Set(allowedServers)
		servers = servers.filter((s) => allowSet.has(s.name))
	}

	// Prefix stability (WS-F): the tools array is part of the request prefix for
	// providers that cache tool schemas, so its order must depend on the config
	// only. `getServers()` returns connection order, and a server that reconnects
	// (config edit, file watcher, manual restart) is deleted and re-appended, so
	// it would jump to the end of the array and shift every schema after it.
	// Sorting by name removes that. Tool order WITHIN a server is left as the
	// server reported it: that order is the server author's, and it is stable for
	// a given server version. The UI keeps using `getServers()` directly, so the
	// user still sees their servers in config order.
	servers = [...servers].sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1))
	const tools: OpenAI.Chat.ChatCompletionTool[] = []
	// Track seen tool names to prevent duplicates (e.g., when same server exists in both global and project configs)
	const seenToolNames = new Set<string>()

	for (const server of servers) {
		if (!server.tools) {
			continue
		}
		for (const tool of server.tools) {
			// Filter tools where tool.enabledForPrompt is not explicitly false
			if (tool.enabledForPrompt === false) {
				continue
			}

			// Build sanitized tool name for API compliance
			// The name is sanitized to conform to API requirements (e.g., Gemini's function name restrictions)
			const toolName = buildMcpToolName(server.name, tool.name)

			// Skip duplicate tool names - first occurrence wins (project servers come before global servers)
			if (seenToolNames.has(toolName)) {
				continue
			}
			seenToolNames.add(toolName)

			const originalSchema = tool.inputSchema as Record<string, unknown> | undefined

			// Normalize schema for JSON Schema 2020-12 compliance (type arrays → anyOf)
			let parameters: JsonSchema
			if (originalSchema) {
				parameters = normalizeToolSchema(originalSchema) as JsonSchema
			} else {
				// No schema provided - create a minimal valid schema
				parameters = { type: "object", additionalProperties: false } as JsonSchema
			}

			const toolDefinition: OpenAI.Chat.ChatCompletionTool = {
				type: "function",
				function: {
					name: toolName,
					description: tool.description,
					parameters: parameters as OpenAI.FunctionParameters,
				},
			}

			tools.push(toolDefinition)
		}
	}

	return tools
}
