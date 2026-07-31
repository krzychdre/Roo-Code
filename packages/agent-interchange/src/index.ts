import { listClaudeSessions, readClaudeSession } from "./readers/claude-code.js"
import { listTumbleSessions, readTumbleSession } from "./readers/tumble-code.js"
import type { AgentKind, ListOptions, ReadOptions, Session, SessionSummary } from "./types.js"

export * from "./types.js"
export {
	claudeConfigDir,
	claudePlansDir,
	claudeProjectDirs,
	claudeProjectsDir,
	claudeSlug,
	handoffDir,
	tumbleStorageRoots,
	tumbleTaskRoots,
} from "./locate.js"
export { normalizeContent, oneLine, textOf } from "./normalize.js"
export { actionKindOf, extractActions } from "./tools.js"
export {
	collectFacts,
	formatTime,
	metaLines,
	renderBriefing,
	renderSessionList,
	type BriefingFacts,
	type BriefingOptions,
} from "./briefing.js"
export { renderTranscript, type TranscriptOptions, type TranscriptPage } from "./transcript.js"
export {
	createHandoff,
	handoffSummary,
	listHandoffs,
	readHandoff,
	renderHandoffList,
	updateHandoff,
	type CreateHandoffOptions,
	type Handoff,
	type HandoffMeta,
	type HandoffStatus,
	type UpdateHandoffOptions,
} from "./handoffs.js"
export { listPlans, readPlan, renderPlanList, type PlanDoc, type PlanSource } from "./plans.js"
export { renderSearchHits, searchSessions, type SearchHit, type SearchOptions } from "./search.js"
export { findClaudeSessionFile, listClaudeSessions, readClaudeSession } from "./readers/claude-code.js"
export { findTumbleTaskDir, listTumbleSessions, readTumbleSession } from "./readers/tumble-code.js"

/** Sessions from both agents, newest first. */
export function listSessions(options: ListOptions & { agent?: AgentKind } = {}): SessionSummary[] {
	const { agent, limit, ...rest } = options

	const summaries = [
		...(agent === "tumble-code" ? [] : listClaudeSessions(rest)),
		...(agent === "claude-code" ? [] : listTumbleSessions(rest)),
	].sort((a, b) => b.updatedAt - a.updatedAt)

	return limit ? summaries.slice(0, limit) : summaries
}

/**
 * Read a session by id, from whichever store holds it.
 *
 * Ids are disjoint in practice (Claude Code uses a UUID for the file name,
 * Tumble Code a ULID-shaped directory), so `agent` is only needed to skip a
 * lookup, not to disambiguate.
 */
export async function readSession(
	id: string,
	options: ReadOptions & { agent?: AgentKind } = {},
): Promise<Session | undefined> {
	const { agent, ...rest } = options

	if (agent !== "tumble-code") {
		const session = await readClaudeSession(id, rest)

		if (session) {
			return session
		}
	}

	if (agent !== "claude-code") {
		const session = await readTumbleSession(id, rest)

		if (session) {
			return session
		}
	}

	return undefined
}
