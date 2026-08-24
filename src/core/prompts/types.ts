/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .roo/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
	/**
	 * Slim toolset flags, read from the ACTIVE API profile (not global settings).
	 * They must reach the prompt because the prompt's MCP sections have to match
	 * the tool array exactly: advertising an MCP server the model has no schema
	 * for is the classic weak-model trap.
	 */
	slimToolset?: boolean
	slimHidesMcp?: boolean
}
