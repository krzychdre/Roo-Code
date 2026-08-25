import { z } from "zod"

/**
 * Artifact Spill Constants
 *
 * Bounds and defaults for the generic tool-result spill policy: when a tool
 * result is larger than `maxInlineToolResultBytes`, the full text is persisted
 * as a task artifact and only a head/tail preview stays in the conversation.
 */
export const ARTIFACT_SPILL_DEFAULTS = {
	/** Smallest useful inline budget; below this even a preview would not fit. */
	MIN_INLINE_TOOL_RESULT_BYTES: 4096,
	/** Upper bound, mostly an escape hatch for users with huge context windows. */
	MAX_INLINE_TOOL_RESULT_BYTES: 1024 * 1024,
	/** Default inline budget for a single tool result: 24 KB. */
	DEFAULT_INLINE_TOOL_RESULT_BYTES: 24 * 1024,
	/** Lines kept from the start of a spilled result. */
	PREVIEW_HEAD_LINES: 60,
	/** Lines kept from the end of a spilled result. */
	PREVIEW_TAIL_LINES: 60,
} as const

/**
 * ArtifactSpillSettings
 *
 * Global (not per-profile) settings merged into `globalSettingsSchema`, in the
 * same flat style as the web-tool settings so they travel through the generic
 * global-state plumbing without a bespoke message channel.
 */
export const artifactSpillSettingsSchema = z.object({
	/**
	 * Maximum bytes of a single tool result that stay inline in the
	 * conversation. Larger results are saved as an artifact and replaced with a
	 * head/tail preview that cites the artifact id.
	 * @default 24576
	 */
	maxInlineToolResultBytes: z
		.number()
		.min(ARTIFACT_SPILL_DEFAULTS.MIN_INLINE_TOOL_RESULT_BYTES)
		.max(ARTIFACT_SPILL_DEFAULTS.MAX_INLINE_TOOL_RESULT_BYTES)
		.optional(),
})

export type ArtifactSpillSettings = z.infer<typeof artifactSpillSettingsSchema>

/**
 * Resolves the inline budget with the default applied and the bounds clamped,
 * so callers never repeat the `?? DEFAULT` dance and a corrupted setting can
 * never disable the policy entirely.
 */
export const resolveMaxInlineToolResultBytes = (settings: ArtifactSpillSettings | undefined): number => {
	const configured = settings?.maxInlineToolResultBytes

	if (typeof configured !== "number" || !Number.isFinite(configured)) {
		return ARTIFACT_SPILL_DEFAULTS.DEFAULT_INLINE_TOOL_RESULT_BYTES
	}

	return Math.min(
		Math.max(configured, ARTIFACT_SPILL_DEFAULTS.MIN_INLINE_TOOL_RESULT_BYTES),
		ARTIFACT_SPILL_DEFAULTS.MAX_INLINE_TOOL_RESULT_BYTES,
	)
}
