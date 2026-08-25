import { z } from "zod"

/**
 * Prune-Before-Condense Constants
 *
 * Bounds and defaults for the deterministic tool-result pruner that runs on
 * context pressure BEFORE the expensive, lossy LLM summary. A tool result older
 * than the protected recent tail and larger than `pruneToolResultBudget` is
 * moved to a task artifact and replaced by a head/tail preview that cites the
 * artifact id.
 */
export const PRUNE_CONDENSE_DEFAULTS = {
	/**
	 * Smallest budget worth honouring: below this the head/tail preview plus its
	 * notice would be as large as the result it replaces.
	 */
	MIN_TOOL_RESULT_BUDGET: 1024,
	/** Upper bound, an escape hatch for users with very wide context windows. */
	MAX_TOOL_RESULT_BUDGET: 1024 * 1024,
	/** Default budget for a single old tool result: 4 KB. */
	DEFAULT_TOOL_RESULT_BUDGET: 4096,
	/** Lines kept from the start of a pruned result. */
	PREVIEW_HEAD_LINES: 20,
	/** Lines kept from the end of a pruned result. */
	PREVIEW_TAIL_LINES: 20,
} as const

/**
 * PruneCondenseSettings
 *
 * Global (not per-profile) settings merged into `globalSettingsSchema`, in the
 * same flat style as the web-tool and artifact-spill settings so they travel
 * through the generic global-state plumbing without a bespoke message channel.
 */
export const pruneCondenseSettingsSchema = z.object({
	/**
	 * Run the deterministic prune pass before the LLM condense.
	 * Default ON: it is cheaper than a summary and loses nothing that
	 * `read_artifact` cannot recover.
	 * @default true
	 */
	pruneBeforeCondense: z.boolean().optional(),
	/**
	 * Maximum bytes an OLD tool result may keep inline once context pressure
	 * triggers the prune pass. Larger results are saved as a `prune` artifact
	 * and replaced by a head/tail preview that cites the artifact id.
	 * @default 4096
	 */
	pruneToolResultBudget: z
		.number()
		.min(PRUNE_CONDENSE_DEFAULTS.MIN_TOOL_RESULT_BUDGET)
		.max(PRUNE_CONDENSE_DEFAULTS.MAX_TOOL_RESULT_BUDGET)
		.optional(),
})

export type PruneCondenseSettings = z.infer<typeof pruneCondenseSettingsSchema>

/**
 * Resolves the prune budget with the default applied and the bounds clamped, so
 * callers never repeat the `?? DEFAULT` dance and a corrupted setting can never
 * turn the pass into a no-op (or into a pruner that shreds every result).
 */
export const resolvePruneToolResultBudget = (settings: PruneCondenseSettings | undefined): number => {
	const configured = settings?.pruneToolResultBudget

	if (typeof configured !== "number" || !Number.isFinite(configured)) {
		return PRUNE_CONDENSE_DEFAULTS.DEFAULT_TOOL_RESULT_BUDGET
	}

	return Math.min(
		Math.max(configured, PRUNE_CONDENSE_DEFAULTS.MIN_TOOL_RESULT_BUDGET),
		PRUNE_CONDENSE_DEFAULTS.MAX_TOOL_RESULT_BUDGET,
	)
}

/**
 * Whether the prune pass runs. Default ON, so only an explicit `false` (the
 * escape hatch) disables it.
 */
export const isPruneBeforeCondenseEnabled = (settings: PruneCondenseSettings | undefined): boolean =>
	settings?.pruneBeforeCondense !== false
