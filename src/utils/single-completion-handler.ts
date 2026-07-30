import type { ProviderSettings } from "@roo-code/types"

import { buildApiHandler, type CompletionResult, type SingleCompletionHandler } from "../api"

/**
 * Run a one-shot completion and report what it cost.
 *
 * The single place that decides how to call a handler: `completePromptWithUsage`
 * when the provider has it, `completePrompt` otherwise. Every caller goes
 * through here so that "this provider cannot tell us the token count" is
 * handled once, and so a missing figure surfaces as an absent `usage` rather
 * than as a zero that would land in a total as if the call had been free.
 */
export async function runCompletion(handler: SingleCompletionHandler, promptText: string): Promise<CompletionResult> {
	if (typeof handler.completePromptWithUsage === "function") {
		return handler.completePromptWithUsage(promptText)
	}
	return { text: await handler.completePrompt(promptText) }
}

/**
 * Build a handler for a configuration and run a one-shot completion on it,
 * without creating a full Task or touching task history.
 */
export async function singleCompletionWithUsage(
	apiConfiguration: ProviderSettings,
	promptText: string,
): Promise<CompletionResult> {
	if (!promptText) {
		throw new Error("No prompt text provided")
	}
	if (!apiConfiguration || !apiConfiguration.apiProvider) {
		throw new Error("No valid API configuration provided")
	}

	const handler = buildApiHandler(apiConfiguration)

	// Check if handler supports single completions
	if (!("completePrompt" in handler)) {
		throw new Error("The selected API provider does not support prompt enhancement")
	}

	return runCompletion(handler as SingleCompletionHandler, promptText)
}

/**
 * Enhances a prompt using the configured API without creating a full Cline instance or task history.
 * This is a lightweight alternative that only uses the API's completion functionality.
 */
export async function singleCompletionHandler(apiConfiguration: ProviderSettings, promptText: string): Promise<string> {
	return (await singleCompletionWithUsage(apiConfiguration, promptText)).text
}
