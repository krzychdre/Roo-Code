import type OpenAI from "openai"

const RUN_PARALLEL_TASKS_DESCRIPTION = `Run several TINY independent subtasks CONCURRENTLY, each as a headless agent in its own isolated git worktree (separate branch + working directory), then get back an aggregated report of every subtask's result.

WHEN TO USE WHICH DELEGATION TOOL:
- ONE substantial job (a code review, an audit, a design, a feature, a large refactor) → delegate it as ONE \`new_task\` to the right specialist mode. NEVER split a substantial job into run_parallel_tasks chunks, not even ask-mode chunks like "review half of the project each". A big job sliced into pieces is still a big job, and chunked reviewers/editors that cannot see each other's work produce fragmented, conflicting results.
- SEVERAL genuinely separate tiny jobs that happen to be pending at once → run_parallel_tasks.

A subtask QUALIFIES only if ALL of these hold:
- you have AT LEAST TWO of them: a single-subtask call is rejected. One job means no fan-out: do it directly in this task, or new_task it to a specialist;
- you can state it in one or two sentences with a concrete, checkable outcome;
- a single agent can finish it in a few minutes, one-shot, no follow-up work;
- it is INDEPENDENT of the other subtasks (dependent steps must be sequential).
Examples that qualify: "what does function X in file Y do and who calls it?", one specific web lookup, a small scoped edit to one or two named files, "run the test suite Z and report failures". If your honest split produces subtasks that are themselves big, the job does not belong here, so use new_task.

Each subtask runs autonomously (mostly without user interaction: the user can watch each subtask live, answer a subtask's clarifying question, or cancel one) and cannot see the others' work while running; results are merged into your next turn.

Guidance:
- "architect" and "orchestrator" modes are REJECTED for subtasks; planning and orchestration happen in YOUR task.
- Subtasks CANNOT delegate: new_task and run_parallel_tasks are unavailable inside a subtask. Never assign a subtask that would need to split work further, do that splitting yourself, here.
- Give each subtask a self-contained \`message\` with all the context it needs: a subtask starts fresh and shares no memory with you or its siblings.
- Worktrees and branches are left intact for review; nothing is auto-merged.

CRITICAL: This tool MUST be called alone. Do NOT call it alongside other tools in the same message turn.`

const SUBTASKS_DESCRIPTION = `The subtasks to run in parallel. Each is an object with a self-contained \`message\` (the full instructions/context for that subtask) and an optional \`mode\` slug (e.g. ask, code, debug; defaults to code).`

const MAX_CONCURRENCY_DESCRIPTION = `Maximum number of subtasks to run at once (default 3). Use null for the default. Keep modest to respect API rate limits. Values above the user's configured limit are clamped to it, never rejected.`

export default {
	type: "function",
	function: {
		name: "run_parallel_tasks",
		description: RUN_PARALLEL_TASKS_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				subtasks: {
					type: "array",
					description: SUBTASKS_DESCRIPTION,
					items: {
						type: "object",
						properties: {
							message: {
								type: "string",
								description: "Self-contained instructions and context for this subtask.",
							},
							mode: {
								type: ["string", "null"],
								description: "Mode slug to run this subtask in (e.g. code, debug). Null = code.",
							},
						},
						required: ["message", "mode"],
						additionalProperties: false,
					},
				},
				maxConcurrency: {
					type: ["number", "null"],
					description: MAX_CONCURRENCY_DESCRIPTION,
				},
			},
			required: ["subtasks", "maxConcurrency"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
