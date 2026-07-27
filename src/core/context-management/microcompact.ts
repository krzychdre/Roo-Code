import { Anthropic } from "@anthropic-ai/sdk"

import { ApiMessage } from "../task-persistence/apiMessages"
import { getEffectiveApiHistory } from "../condense"

/**
 * Tool-result microcompaction.
 *
 * A cheap, deterministic, NO-LLM pre-pass that clears the *content* of OLD tool
 * results before resorting to the expensive, lossy full summarization
 * (`summarizeConversation`). This is a port of Claude Code's `microcompact`
 * stage, which runs before `autocompact` in its compaction pipeline. Old tool
 * output (file reads, command stdout, search results, ...) is the largest,
 * lowest-signal, fastest-growing portion of a coding conversation, so clearing
 * it reclaims the bulk of the tokens while leaving the entire dialogue —
 * user/assistant turns, decisions, and the `tool_use` requests themselves —
 * completely intact.
 *
 * Selection is need-adaptive and importance-aware rather than count-based: the
 * caller says how many characters it must reclaim, and this pass clears the
 * oldest results until that target is met, skipping results too small to pay for
 * their own placeholder and sparing the ones the context ledger marks critical.
 * A count rule cannot do this — "keep five" treats a 123-char test failure and a
 * 192 KB directory listing as the same thing.
 *
 * Because it makes no model call, it cannot fail or hallucinate on a weak local
 * model (GLM/Qwen/Llama); the cleared content is simply replaced with a fixed,
 * human-readable sentinel that tells the model how to recover the data if needed.
 */

/**
 * Placeholder that replaces the content of an old tool result when it is
 * microcompacted. Written to be explicit and actionable so that even weak local
 * models understand the content was intentionally removed and know the recovery
 * action, rather than treating the cleared block as an empty (failed) result.
 */
export const MICROCOMPACT_CLEARED_PLACEHOLDER =
	"[Old tool output cleared to save context. Re-read the file or re-run the command if you need this output again.]"

/** Length of the placeholder each cleared result is replaced by; it is not free. */
export const MICROCOMPACT_PLACEHOLDER_CHARS = MICROCOMPACT_CLEARED_PLACEHOLDER.length

/**
 * Characters per token as `estimateTokenCount` reports them, used to turn the caller's
 * token-denominated reclaim need into the char-denominated budget selection works in.
 *
 * Measured over 4,638 stored tool results across 188 tasks: 3.76 chars per tiktoken
 * (o200k) token, stable across size buckets (3.64 under 2 KB, 3.74 at 2–20 KB, 3.82 at
 * 20 KB+). `estimateTokenCount` multiplies tiktoken by `TOKEN_FUDGE_FACTOR` (1.5), so the
 * ratio against the number the caller compares us to is 3.76 / 1.5 = 2.51.
 */
export const MICROCOMPACT_CHARS_PER_TOKEN = 2.5

/**
 * What one placeholder costs on the `estimateTokenCount` scale. Clearing a result removes
 * its text but writes this back, so the tokens actually reclaimed are the text's tokens
 * MINUS this, per cleared result.
 */
export const MICROCOMPACT_PLACEHOLDER_TOKENS = Math.ceil(MICROCOMPACT_PLACEHOLDER_CHARS / MICROCOMPACT_CHARS_PER_TOKEN)

/**
 * Newest compactable results that this pass never clears, whatever the pressure.
 *
 * This is a floor, not a policy: selection walks OLDEST-first and stops the moment the
 * caller's reclaim target is met, so recent results are only ever reached under extreme
 * pressure. Three slots keep the model's immediate working set — the result it just
 * received plus the two before it — which weak local models depend on to stay coherent.
 * The old count-based rule used five slots as its ENTIRE policy; measured against the
 * on-disk task store, 66.3% of those five slots held results under 2 KB, i.e. two thirds
 * of the protection budget was spent on results that cost nothing to keep and nothing to
 * reclaim, while one recent 192 KB search result could sit in the same window unbounded.
 */
export const MICROCOMPACT_MIN_KEEP = 3

/**
 * Results smaller than this are never cleared, at any age.
 *
 * Clearing costs `MICROCOMPACT_PLACEHOLDER_CHARS` (112) to write the sentinel, so a
 * 300-char result reclaims ~77 tokens while destroying a fact outright. In the task store
 * results under 2 KB are 55.2% of all compactable items but only 6.96% of the bytes:
 * exempting them forfeits almost no reclaim and saves more than half the facts. Failures
 * in particular are tiny — median 123 chars against 1,275 for successes — so the cheapest
 * results to keep are also the most expensive ones to lose.
 */
export const MICROCOMPACT_CLEAR_FLOOR_CHARS = 2_000

/**
 * Upper size bound on importance protection.
 *
 * A result the ledger marks critical (unresolved error, validation outcome, file write)
 * is protected only while it stays under this size, so a 123-char failure survives but a
 * 140 KB failing-build log is still clearable. Without the bound, protection would become
 * the new unbounded window the byte budget exists to eliminate.
 */
export const MICROCOMPACT_PROTECT_MAX_CHARS = 8_000

/**
 * Reclaim this much more than strictly needed.
 *
 * Landing exactly on the threshold means the next turn is over it again and re-selects,
 * moving the sent prefix every turn and defeating prompt caching. Overshooting buys a
 * turn or two of headroom for the cost of a little extra reclaim.
 */
export const MICROCOMPACT_TARGET_MARGIN = 1.1

/**
 * Converts "we are N tokens over budget" into the character target selection consumes.
 * Returns 0 when there is no pressure, which selects nothing.
 */
export function microcompactTargetChars(tokensOverBudget: number): number {
	if (!Number.isFinite(tokensOverBudget) || tokensOverBudget <= 0) {
		return 0
	}
	return Math.ceil(tokensOverBudget * MICROCOMPACT_TARGET_MARGIN * MICROCOMPACT_CHARS_PER_TOKEN)
}

/**
 * Tool names whose results are bulky and cheaply re-derivable (re-read / re-run),
 * making them safe to clear. Mirrors Claude Code's `COMPACTABLE_TOOLS` set.
 *
 * Results from tools NOT in this set (e.g. attempt_completion,
 * ask_followup_question, update_todo_list, switch_mode, new_task, skill,
 * run_slash_command, generate_image, tools_load) are ALWAYS preserved — they
 * carry irreplaceable state or are small enough that clearing them is pointless.
 */
export const COMPACTABLE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
	"read_file",
	"read_command_output",
	"execute_command",
	"search_files",
	"list_files",
	"codebase_search",
	"use_mcp_tool",
	"access_mcp_resource",
	"write_to_file",
	"apply_diff",
	"apply_patch",
	"edit",
	"edit_file",
	"search_replace",
	"search_and_replace",
])

/** One compactable tool result, as selection sees it. Encounter order, oldest first. */
export interface MicrocompactCandidate {
	toolUseId: string
	/** Size of the result's text payload in characters. */
	chars: number
	/**
	 * The ledger marks this result as carrying a fact that cannot be cheaply re-derived
	 * (unresolved error, validation outcome, file write). See `buildContextLedger`.
	 */
	critical: boolean
}

export interface MicrocompactSelectionOptions {
	/**
	 * Characters that must be reclaimed to get back under the caller's thresholds.
	 * Selection stops as soon as this is met — it reclaims what is needed, not what is
	 * possible. Omit (or pass Infinity) to clear everything eligible.
	 */
	targetChars?: number
	/**
	 * Ids cleared on a PREVIOUS request. Always kept cleared, so the sent prefix only ever
	 * grows: a set that shrinks between turns would move the first changed position
	 * backwards and invalidate the provider's prompt cache from there.
	 */
	alreadyCleared?: ReadonlySet<string>
	minKeep?: number
	clearFloorChars?: number
	protectMaxChars?: number
}

export interface MicrocompactSelection {
	/** The tool_use_ids to clear. */
	clearIds: Set<string>
	/** Chars reclaimed NET of the placeholder written in each cleared result's place. */
	reclaimedChars: number
	/** Critical results importance protection kept out of the selection. */
	protectedCount: number
	/** Critical results protection had to release because the target was otherwise unmet. */
	releasedProtectedCount: number
}

export interface MicrocompactOptions extends Omit<MicrocompactSelectionOptions, "alreadyCleared"> {
	/** `ContextLedger.criticalToolUseIds` — results whose facts earn importance protection. */
	criticalToolUseIds?: ReadonlySet<string>
	/** Ids cleared on a previous request; see `MicrocompactSelectionOptions.alreadyCleared`. */
	alreadyClearedToolUseIds?: ReadonlySet<string>
}

export interface MicrocompactResult {
	/**
	 * The full message array with old compactable tool-result content cleared.
	 * Returns the SAME reference as the input when nothing was changed, so callers
	 * can cheaply detect a no-op with `result.messages === messages`.
	 */
	messages: ApiMessage[]
	/** Number of tool results whose content was cleared. */
	clearedCount: number
	/** The tool_use_ids whose results were cleared. */
	clearedToolUseIds: string[]
	/**
	 * Concatenation of the original cleared content as plain text. Lets the caller
	 * estimate the freed token count with a single `countTokens` call instead of
	 * recounting the whole (large) history.
	 */
	clearedText: string
	/** Compactable results considered this pass (cleared or not). */
	candidateCount: number
	/** Chars reclaimed net of placeholders, as selection counted them. */
	reclaimedChars: number
	/** Critical results importance protection kept raw. */
	protectedCount: number
	/** Critical results protection released to reach the target. */
	releasedProtectedCount: number
}

/**
 * Flattens a tool_result block's content to plain text, for token estimation of
 * what is being removed. Images/other blocks are noted but not measured here
 * (image token cost is handled elsewhere).
 */
function toolResultContentToText(content: Anthropic.Messages.ToolResultBlockParam["content"]): string {
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (block.type === "text") {
					return block.text
				}
				return ""
			})
			.join("\n")
	}
	return ""
}

/** A tool_result whose content has already been cleared by a prior pass. */
function isAlreadyCleared(block: Anthropic.Messages.ToolResultBlockParam): boolean {
	return block.content === MICROCOMPACT_CLEARED_PLACEHOLDER
}

/**
 * Chooses which compactable tool results to clear.
 *
 * Pure, deterministic and separately testable. Walks OLDEST-first and stops the moment
 * `targetChars` is met, so the pass reclaims what the caller needs rather than everything
 * it could. Oldest-first is not cosmetic: because the cleared set only grows, clearing a
 * prefix keeps the first byte that differs from the previous request as late in the
 * conversation as possible, which is exactly what the provider's prompt cache rewards.
 *
 * Three terms decide eligibility, and every one of them can only move a result from
 * "cleared" to "kept". The worst case is therefore always LESS reclaim, never lost data —
 * and even a cleared result is only stripped from the outgoing copy, never from storage.
 *
 * 1. `minKeep`   — the newest results are off limits (immediate working set).
 * 2. `clearFloorChars` — results too small for clearing to pay for its own placeholder.
 * 3. `protectMaxChars` — critical results stay raw while they are small enough to be worth
 *    the space, releasing only if the target cannot be met without them. Releasing is the
 *    lesser evil: falling short here hands the whole conversation to the lossy condense.
 */
export function selectMicrocompactTargets(
	candidates: readonly MicrocompactCandidate[],
	options: MicrocompactSelectionOptions = {},
): MicrocompactSelection {
	const targetChars = options.targetChars ?? Number.POSITIVE_INFINITY
	const minKeep = Math.max(0, options.minKeep ?? MICROCOMPACT_MIN_KEEP)
	// Never accept a floor below the placeholder's own length — clearing at that size is
	// pure loss with zero reclaim.
	const clearFloorChars = Math.max(
		MICROCOMPACT_PLACEHOLDER_CHARS,
		options.clearFloorChars ?? MICROCOMPACT_CLEAR_FLOOR_CHARS,
	)
	const protectMaxChars = options.protectMaxChars ?? MICROCOMPACT_PROTECT_MAX_CHARS

	const clearIds = new Set<string>()
	let reclaimedChars = 0

	const take = (candidate: MicrocompactCandidate) => {
		clearIds.add(candidate.toolUseId)
		reclaimedChars += Math.max(0, candidate.chars - MICROCOMPACT_PLACEHOLDER_CHARS)
	}

	// Carry over every prior decision first, including any that today's terms would spare:
	// monotonicity of the sent prefix outranks the policy, and re-inflating a result the
	// model has already seen cleared only confuses it.
	if (options.alreadyCleared?.size) {
		for (const candidate of candidates) {
			if (options.alreadyCleared.has(candidate.toolUseId)) {
				take(candidate)
			}
		}
	}

	const eligible = candidates.slice(0, Math.max(0, candidates.length - minKeep))

	let protectedCount = 0
	let releasedProtectedCount = 0

	// Pass 1 — honour importance protection.
	for (const candidate of eligible) {
		if (reclaimedChars >= targetChars) {
			break
		}
		if (clearIds.has(candidate.toolUseId) || candidate.chars < clearFloorChars) {
			continue
		}
		if (candidate.critical && candidate.chars <= protectMaxChars) {
			protectedCount++
			continue
		}
		take(candidate)
	}

	// Pass 2 — still short, so release protection (the floor and `minKeep` still hold).
	if (reclaimedChars < targetChars) {
		for (const candidate of eligible) {
			if (reclaimedChars >= targetChars) {
				break
			}
			if (clearIds.has(candidate.toolUseId) || candidate.chars < clearFloorChars) {
				continue
			}
			take(candidate)
			protectedCount--
			releasedProtectedCount++
		}
	}

	return { clearIds, reclaimedChars, protectedCount, releasedProtectedCount }
}

/**
 * Clears the content of old compactable tool results, oldest first, until `targetChars`
 * is reclaimed. Pure and idempotent: re-running on already-microcompacted messages is a
 * no-op for the already-cleared blocks.
 *
 * @param messages The full API conversation history (including tagged messages).
 * @param options Selection budget plus the ledger's critical ids; see `selectMicrocompactTargets`.
 * @returns The (possibly new) message array plus what was cleared.
 */
export function microcompactToolResults(messages: ApiMessage[], options: MicrocompactOptions = {}): MicrocompactResult {
	const noop: MicrocompactResult = {
		messages,
		clearedCount: 0,
		clearedToolUseIds: [],
		clearedText: "",
		candidateCount: 0,
		reclaimedChars: 0,
		protectedCount: 0,
		releasedProtectedCount: 0,
	}

	// Only consider the effective (non-condensed, non-truncated) history. Hidden
	// messages are filtered out before the API anyway, so clearing them is moot,
	// and selecting "recent" within them would be wrong.
	const effective = getEffectiveApiHistory(messages)

	// Map tool_use_id -> tool name from assistant tool_use blocks so we can tell
	// which results came from compactable (bulky, re-derivable) tools.
	const toolNameById = new Map<string, string>()
	for (const msg of effective) {
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_use") {
					toolNameById.set(block.id, block.name)
				}
			}
		}
	}

	// Collect compactable results in encounter order (oldest first), with the size and
	// importance selection needs. Blocks a previous pass already cleared are not
	// candidates: they hold the placeholder, so there is nothing left to reclaim.
	const critical = options.criticalToolUseIds
	const candidates: MicrocompactCandidate[] = []
	for (const msg of effective) {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result") {
					const tr = block as Anthropic.Messages.ToolResultBlockParam
					const name = toolNameById.get(tr.tool_use_id)
					if (!name || !COMPACTABLE_TOOL_NAMES.has(name) || isAlreadyCleared(tr)) {
						continue
					}
					candidates.push({
						toolUseId: tr.tool_use_id,
						chars: toolResultContentToText(tr.content).length,
						critical: critical?.has(tr.tool_use_id) ?? false,
					})
				}
			}
		}
	}

	if (candidates.length === 0) {
		return noop
	}

	const selection = selectMicrocompactTargets(candidates, {
		targetChars: options.targetChars,
		alreadyCleared: options.alreadyClearedToolUseIds,
		minKeep: options.minKeep,
		clearFloorChars: options.clearFloorChars,
		protectMaxChars: options.protectMaxChars,
	})

	const clearSet = selection.clearIds
	if (clearSet.size === 0) {
		return { ...noop, candidateCount: candidates.length, protectedCount: selection.protectedCount }
	}

	const clearedToolUseIds: string[] = []
	let clearedText = ""

	const newMessages = messages.map((msg) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) {
			return msg
		}
		let touched = false
		const newContent = msg.content.map((block) => {
			if (block.type === "tool_result") {
				const tr = block as Anthropic.Messages.ToolResultBlockParam
				if (clearSet.has(tr.tool_use_id) && !isAlreadyCleared(tr)) {
					const text = toolResultContentToText(tr.content)
					if (text) {
						clearedText += text + "\n"
					}
					clearedToolUseIds.push(tr.tool_use_id)
					touched = true
					return { ...tr, content: MICROCOMPACT_CLEARED_PLACEHOLDER }
				}
			}
			return block
		})
		if (!touched) {
			return msg
		}
		return { ...msg, content: newContent }
	})

	if (clearedToolUseIds.length === 0) {
		return { ...noop, candidateCount: candidates.length, protectedCount: selection.protectedCount }
	}

	return {
		messages: newMessages,
		clearedCount: clearedToolUseIds.length,
		clearedToolUseIds,
		clearedText,
		candidateCount: candidates.length,
		reclaimedChars: selection.reclaimedChars,
		protectedCount: selection.protectedCount,
		releasedProtectedCount: selection.releasedProtectedCount,
	}
}

/**
 * Send-time, NON-DESTRUCTIVE application of a microcompaction decision.
 *
 * Given a set of `tool_use_id`s chosen for clearing (by `microcompactToolResults`
 * against the current model's budget), returns a COPY of `messages` with the
 * content of any matching `tool_result` block replaced by
 * `MICROCOMPACT_CLEARED_PLACEHOLDER`. The input array and its messages are never
 * mutated — this is meant to run on the outgoing request copy while the stored
 * `apiConversationHistory` stays pristine (cache-stable, rewind-safe, and correct
 * across mid-task mode switches: a wider-window model simply passes an empty set).
 *
 * Idempotent and cheap: returns the SAME reference when the set is empty or no
 * block matches, so callers can skip work with `result === messages`.
 */
export function applyMicrocompactCleared(messages: ApiMessage[], clearedToolUseIds: ReadonlySet<string>): ApiMessage[] {
	if (clearedToolUseIds.size === 0) {
		return messages
	}

	let anyTouched = false
	const result = messages.map((msg) => {
		if (msg.role !== "user" || !Array.isArray(msg.content)) {
			return msg
		}
		let touched = false
		const newContent = msg.content.map((block) => {
			if (block.type === "tool_result") {
				const tr = block as Anthropic.Messages.ToolResultBlockParam
				if (clearedToolUseIds.has(tr.tool_use_id) && !isAlreadyCleared(tr)) {
					touched = true
					return { ...tr, content: MICROCOMPACT_CLEARED_PLACEHOLDER }
				}
			}
			return block
		})
		if (!touched) {
			return msg
		}
		anyTouched = true
		return { ...msg, content: newContent }
	})

	return anyTouched ? result : messages
}
