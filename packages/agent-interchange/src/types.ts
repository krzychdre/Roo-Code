/**
 * The canonical model both stores are normalized into.
 *
 * Claude Code keeps a session as JSONL records whose `message` field is an
 * Anthropic wire message; Tumble Code keeps `api_conversation_history.json`,
 * an array of the same message shape plus a `ts`. The content blocks therefore
 * already agree — what differs is the envelope, the metadata and the tool
 * vocabulary. Everything below is the intersection, plus the metadata each side
 * happens to carry (optional, because the other side usually lacks it).
 */

export type AgentKind = "claude-code" | "tumble-code"

export const AGENT_LABELS: Record<AgentKind, string> = {
	"claude-code": "Claude Code",
	"tumble-code": "Tumble Code",
}

export type InterchangeBlock =
	| { type: "text"; text: string }
	/** `thinking` in Claude Code, `reasoning` in Tumble Code. */
	| { type: "thinking"; text: string }
	| { type: "tool_use"; id?: string; name: string; input: unknown }
	| { type: "tool_result"; toolUseId?: string; text: string; isError?: boolean }
	| { type: "image"; mediaType?: string }

export interface InterchangeMessage {
	role: "user" | "assistant"
	/** Epoch ms. Claude Code records carry one per line; Tumble Code per message. */
	ts?: number
	blocks: InterchangeBlock[]
	/** Claude Code subagent turns (`isSidechain: true`) live in the same file. */
	isSidechain?: boolean
	model?: string
}

export interface SessionSummary {
	agent: AgentKind
	/** `sessionId` (Claude Code) or `taskId` (Tumble Code). */
	id: string
	title: string
	/** Workspace the session ran in. Absolute path, as recorded by the agent. */
	cwd?: string
	gitBranch?: string
	/** Epoch ms of the first record. */
	createdAt: number
	/** Epoch ms of the last record — what listings sort by. */
	updatedAt: number
	/** Absolute path of the JSONL file (Claude Code) or task directory (Tumble Code). */
	path: string
	sizeBytes?: number
	/** Only populated by a full read; listing does not pay to count messages. */
	messageCount?: number
	mode?: string
	model?: string
	apiConfigName?: string
	status?: string
	parentId?: string
	childIds?: string[]
	/** Tumble Code records the summary a finished delegate handed back. */
	resultSummary?: string
	tokensIn?: number
	tokensOut?: number
	totalCost?: number
}

export interface Session extends SessionSummary {
	messages: InterchangeMessage[]
	/** Sidechain (subagent) turns, when the reader was asked to keep them apart. */
	sidechainMessages?: InterchangeMessage[]
}

export interface ListOptions {
	/** Restrict to sessions recorded against this workspace. */
	cwd?: string
	/** Only sessions updated at or after this epoch-ms timestamp. */
	since?: number
	/** Case-insensitive substring match against the title. */
	query?: string
	limit?: number
}

export interface ReadOptions {
	/** Include Claude Code subagent turns in `messages`. Default: keep them separate. */
	includeSidechains?: boolean
}

/**
 * A tool call reduced to what a briefing cares about, with the two vocabularies
 * (`Read`/`Edit`/`Bash` vs `read_file`/`apply_diff`/`execute_command`) collapsed
 * onto one set of verbs.
 */
export type ActionKind =
	| "read"
	| "write"
	| "command"
	| "search"
	| "plan"
	| "todo"
	| "question"
	| "delegate"
	| "complete"
	| "web"
	| "other"

export interface ToolAction {
	kind: ActionKind
	/** The tool name as the originating agent spelled it. */
	tool: string
	paths?: string[]
	command?: string
	/** Free text the briefing wants verbatim: a plan, a question, a result. */
	text?: string
	messageIndex: number
}
