// cd src && npx vitest run core/task/__tests__/searchTaskHistory.spec.ts

import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, it, expect, beforeEach, afterEach } from "vitest"

import type { ApiMessage } from "../../task-persistence/apiMessages"
import {
	HISTORY_SEARCH_DEFAULTS,
	SEARCH_TASK_HISTORY_RESULT_MARKER,
	artifactSearchSources,
	clampMaxResults,
	compileHistoryQuery,
	extractMessageText,
	formatHistorySearchOutcome,
	messageSearchSources,
	readTaskArtifacts,
	searchHistorySources,
	searchTaskHistoryCorpus,
	type TaskArtifactText,
} from "../searchTaskHistory"

/** Builds a text message with an explicit timestamp. */
function message(role: "user" | "assistant", text: string, ts: number): ApiMessage {
	return { role, ts, content: [{ type: "text", text }] }
}

/** Runs the full pipeline the way the tool does. */
function search(messages: ApiMessage[], artifacts: TaskArtifactText[], query: string, maxResults?: number): string {
	return searchTaskHistoryCorpus({ messages, artifacts, query, maxResults }).text
}

describe("compileHistoryQuery", () => {
	it("compiles a valid pattern as a case-insensitive regular expression", () => {
		const { regex, usedRegex } = compileHistoryQuery("time(d)? out")

		expect(usedRegex).toBe(true)
		expect(regex.test("The request TIMED OUT")).toBe(true)
	})

	it("falls back to a literal search when the pattern does not compile", () => {
		const { regex, usedRegex } = compileHistoryQuery("resolve(config")

		expect(usedRegex).toBe(false)
		expect(regex.test("called resolve(config, state)")).toBe(true)
		expect(regex.test("called resolveconfig")).toBe(false)
	})

	it("is case-insensitive in both modes", () => {
		expect(compileHistoryQuery("MISSING").regex.test("a missing value")).toBe(true)
		expect(compileHistoryQuery("Missing(").regex.test("a MISSING( value")).toBe(true)
	})

	it("unwraps a slash-delimited pattern, with or without flags", () => {
		const withFlag = compileHistoryQuery("/error/i")
		expect(withFlag.mode).toBe("regex")
		expect(withFlag.regex.test("an ERROR happened")).toBe(true)
		expect(withFlag.regex.test("no problem")).toBe(false)

		const bare = compileHistoryQuery("/time(d)? out/")
		expect(bare.mode).toBe("regex")
		expect(bare.regex.test("it timed out")).toBe(true)

		expect(compileHistoryQuery("/pool|queue/ms").regex.flags.split("").sort().join("")).toBe("ims")
	})

	it("leaves a path-looking query alone when the trailing part is not a flag set", () => {
		const compiled = compileHistoryQuery("/usr/local/bin/tumble")

		expect(compiled.mode).toBe("regex")
		expect(compiled.regex.test("ran /usr/local/bin/tumble")).toBe(true)
	})

	it("refuses a pattern that can backtrack exponentially and searches literally", () => {
		const compiled = compileHistoryQuery("(a+)+b")

		expect(compiled.mode).toBe("unsafe")
		expect(compiled.usedRegex).toBe(false)
		// Literal: it now matches the pattern text itself, not a run of a's.
		expect(compiled.regex.test("we wrote (a+)+b in the doc")).toBe(true)
		expect(compiled.regex.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false)
	})

	it.each([
		["(a+)+b", "unsafe"],
		["(a*)*c", "unsafe"],
		["(?:\\d+)*", "unsafe"],
		["(x|y+)*", "unsafe"],
		["(a{2,})+", "unsafe"],
		["(foo|bar)+", "regex"],
		["(a+)", "regex"],
		["answer is \\d+", "regex"],
		["timeout|timed out", "regex"],
		["(ab){2,4}", "regex"],
	])("classifies %s as %s", (pattern, mode) => {
		expect(compileHistoryQuery(pattern).mode).toBe(mode)
	})
})

describe("extractMessageText", () => {
	it("flattens text, tool calls and tool results", () => {
		const text = extractMessageText({
			role: "assistant",
			content: [
				{ type: "text", text: "reading the config" },
				{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "src/app.ts" } },
			],
		} as ApiMessage)

		expect(text).toContain("reading the config")
		expect(text).toContain("[tool_use read_file]")
		expect(text).toContain('"path":"src/app.ts"')
	})

	it("reads tool_result content in both string and block form", () => {
		const asString = extractMessageText({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call_1", content: "PORT=8085" }],
		} as ApiMessage)

		const asBlocks = extractMessageText({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "PORT=8085" }] }],
		} as ApiMessage)

		expect(asString).toContain("PORT=8085")
		expect(asBlocks).toContain("PORT=8085")
	})

	it("accepts a plain string body", () => {
		expect(extractMessageText({ role: "user", content: "just a string" } as ApiMessage)).toBe("just a string")
	})

	it("ignores blocks with no text, such as images", () => {
		const text = extractMessageText({
			role: "user",
			content: [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
				{ type: "text", text: "see the screenshot" },
			],
		} as ApiMessage)

		expect(text).toBe("see the screenshot")
	})
})

describe("searchTaskHistoryCorpus", () => {
	it("finds a line that only exists before the condense boundary", () => {
		const messages: ApiMessage[] = [
			// This one carries the condenseParent tag, so the model can no
			// longer see it inline, but it is still on disk.
			{ ...message("user", "the staging database password is hunter2", 1_000), condenseParent: "summary-1" },
			{ role: "user", ts: 2_000, isSummary: true, condenseId: "summary-1", content: "Summary of the work." },
			message("assistant", "continuing", 3_000),
		]

		const result = search(messages, [], "staging database password")

		expect(result).toContain("hunter2")
		expect(result).toContain("message 0 (user)")
	})

	it("finds a line that only exists in a prune artifact", () => {
		const messages: ApiMessage[] = [
			message("user", "run the build", 1_000),
			message("assistant", '[Pruned 40000 bytes ... artifact "prune-1700000000000.txt"]', 2_000),
		]
		const artifacts: TaskArtifactText[] = [
			{ id: "prune-1700000000000.txt", text: "line one\nERR_MODULE_NOT_FOUND in packages/types\nline three" },
		]

		const result = search(messages, artifacts, "ERR_MODULE_NOT_FOUND")

		expect(result).toContain("ERR_MODULE_NOT_FOUND in packages/types")
		expect(result).toContain("artifact prune-1700000000000.txt")
	})

	it("keeps two lines of context on each side of the match", () => {
		const artifacts: TaskArtifactText[] = [
			{ id: "tool-1700000000000.txt", text: ["a", "b", "c", "NEEDLE", "d", "e", "f"].join("\n") },
		]

		const result = search([], artifacts, "NEEDLE")

		expect(result).toContain("b")
		expect(result).toContain("> 4 | NEEDLE")
		expect(result).toContain("e")
		expect(result).not.toContain("| a")
		expect(result).not.toContain("| f")
	})

	it("is case-insensitive", () => {
		const result = search([message("user", "The Retry Wrapper is in client.ts", 1_000)], [], "retry wrapper")

		expect(result).toContain("The Retry Wrapper is in client.ts")
	})

	it("searches literally when the query is not a valid regular expression", () => {
		const messages = [message("user", "call resolve(config, state) first", 1_000)]

		const result = search(messages, [], "resolve(config")

		expect(result).toContain("resolve(config, state)")
		expect(result).toContain("as literal text")
	})

	it("reports zero matches with a corrective instruction instead of an empty result", () => {
		const result = search([message("user", "nothing to see", 1_000)], [], "absent-token")

		expect(result).toContain("No match")
		expect(result).toContain("search one word instead of a phrase")
		expect(result).toContain("search_files")
	})

	it("caps the result count, keeps the newest and says how many were omitted", () => {
		const messages = [1, 2, 3, 4, 5].map((n) => message("user", `budget item ${n}`, n * 1_000))

		const result = search(messages, [], "budget item", 2)

		expect(result).toContain("matched 5 line(s)")
		expect(result).toContain("3 older match(es) are not shown")
		// The two newest survive the cap...
		expect(result).toContain("budget item 4")
		expect(result).toContain("budget item 5")
		expect(result).not.toContain("budget item 1")
		// ...and are printed oldest first.
		expect(result.indexOf("budget item 4")).toBeLessThan(result.indexOf("budget item 5"))
	})

	it("orders hits chronologically across messages and artifacts", () => {
		const messages = [message("user", "marker in the first message", 1_000), message("user", "marker again", 3_000)]
		const artifacts: TaskArtifactText[] = [{ id: "prune-2000.txt", text: "marker inside the artifact" }]

		const result = search(messages, artifacts, "marker")

		expect(result.indexOf("marker in the first message")).toBeLessThan(result.indexOf("marker inside the artifact"))
		expect(result.indexOf("marker inside the artifact")).toBeLessThan(result.indexOf("marker again"))
	})

	it("does not return the same line twice when it lives in both the history and an artifact", () => {
		const shared = "FATAL: pool exhausted at 512 connections"
		const messages = [message("assistant", `head preview\n${shared}\n[Pruned ...]`, 1_000)]
		const artifacts: TaskArtifactText[] = [{ id: "prune-2000.txt", text: `noise\n${shared}\nmore noise` }]

		const result = search(messages, artifacts, "pool exhausted")

		// Both counts are reported, so the removed copy never looks like a lost match.
		expect(result).toContain("matched 2 line(s), 1 after removing duplicate copies")
		expect(result.split(shared).length - 1).toBe(1)
		// The LATEST copy wins: it is the untruncated artifact text, and keeping
		// it is what makes "the most recent match(es)" in the header true.
		expect(result).toContain("artifact prune-2000.txt")
		expect(result).not.toContain("message 0 (assistant)")
	})

	it("returns the newest copy of a repeated line, with its own context", () => {
		// Reviewer repro: the same error line at ts 1000 and ts 9000, one result.
		const error = "TypeError: cannot read property id of undefined"
		const messages = [
			message("assistant", `first run\n${error}\nold context line`, 1_000),
			message("assistant", `second run\n${error}\nnew context line`, 9_000),
		]

		const result = search(messages, [], "cannot read property", 1)

		expect(result).toContain("message 1 (assistant)")
		expect(result).toContain("new context line")
		expect(result).not.toContain("old context line")
		expect(result).toContain("matched 2 line(s), 1 after removing duplicate copies")
	})

	it("truncates an enormous matching line instead of re-injecting it whole", () => {
		const huge = `PREFIX ${"x".repeat(50_000)}`
		const result = search([message("user", huge, 1_000)], [], "PREFIX")

		expect(result).toContain("...[truncated]")
		expect(Buffer.byteLength(result, "utf8")).toBeLessThan(
			HISTORY_SEARCH_DEFAULTS.MAX_HIT_BYTES + 2_000, // header + one capped block
		)
	})

	it("names the corpus it searched so the model can judge the answer", () => {
		const result = search([message("user", "token here", 1_000)], [{ id: "tool-2000.txt", text: "x" }], "token")

		expect(result).toContain("1 stored message(s) and 1 artifact file(s)")
	})
})

describe("self-echo exclusion", () => {
	/**
	 * The assistant turn holding the search_task_history call is persisted
	 * BEFORE the tool runs, so without the carve-out every query would match its
	 * own invocation and the zero-hit path would be unreachable.
	 */
	function invocation(query: string, ts: number): ApiMessage {
		return {
			role: "assistant",
			ts,
			content: [
				{ type: "text", text: "searching the history" },
				{ type: "tool_use", id: `call_${ts}`, name: "search_task_history", input: { query } },
			],
		} as ApiMessage
	}

	function priorResult(text: string, ts: number): ApiMessage {
		return {
			role: "user",
			ts,
			content: [{ type: "tool_result", tool_use_id: `call_${ts}`, content: text }],
		} as ApiMessage
	}

	it("does not match the tool call that is asking the question", () => {
		const messages = [message("user", "unrelated chatter", 1_000), invocation("nowhere-token", 2_000)]

		const result = search(messages, [], "nowhere-token")

		expect(result).toContain("No match")
		expect(result).not.toContain("tool_use search_task_history")
	})

	it("still finds the real hit when the invocation quotes the same query", () => {
		const messages = [
			message("user", "the deploy key lives in vault at secret/ci", 1_000),
			invocation("deploy key", 2_000),
		]

		const result = search(messages, [], "deploy key", 1)

		expect(result).toContain("secret/ci")
		expect(result).toContain("matched 1 line(s)")
	})

	it("does not match its own earlier results", () => {
		const earlier = searchTaskHistoryCorpus({
			messages: [message("user", "the port is 8085", 1_000)],
			artifacts: [],
			query: "port",
		}).text

		const messages = [
			message("user", "the port is 8085", 1_000),
			invocation("port", 2_000),
			priorResult(earlier, 3_000),
		]

		const result = search(messages, [], "port")

		expect(result).toContain("matched 1 line(s)")
		// Message 2 holds the earlier result; no hit may come from it.
		expect(result).not.toContain("message 2 (user)")
		expect(result.split("--- ").length - 1).toBe(1)
	})

	it("does not inflate the match count over repeated rounds", () => {
		// Four rounds of the same search, each round appending its call and its
		// result to the history the next round searches.
		let messages: ApiMessage[] = [message("user", "the port is 8085", 1_000)]
		let lastResult = ""

		for (let round = 0; round < 4; round++) {
			lastResult = searchTaskHistoryCorpus({ messages, artifacts: [], query: "port", maxResults: 1 }).text
			messages = [
				...messages,
				invocation("port", 2_000 + round * 100),
				priorResult(lastResult, 2_050 + round * 100),
			]
		}

		expect(lastResult).toContain("matched 1 line(s)")
		expect(lastResult).toContain("the port is 8085")
	})

	it("skips an artifact that holds an earlier result of this tool", async () => {
		const taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-task-history-echo-"))
		try {
			fs.mkdirSync(path.join(taskDir, "artifacts"), { recursive: true })
			fs.writeFileSync(
				path.join(taskDir, "artifacts", "tool-1700000000005.txt"),
				`${SEARCH_TASK_HISTORY_RESULT_MARKER} "port" matched 3 line(s)\n\n--- message 0 (user) ---\n> 1 | the port is 8085`,
				"utf8",
			)
			fs.writeFileSync(path.join(taskDir, "artifacts", "prune-1700000000006.txt"), "the port is 8085", "utf8")

			const artifacts = await readTaskArtifacts(taskDir)

			expect(artifacts.map((a) => a.id)).toEqual(["prune-1700000000006.txt"])
		} finally {
			fs.rmSync(taskDir, { recursive: true, force: true })
		}
	})
})

describe("cost control", () => {
	it("stops a scan that runs past its wall-clock budget and says what to do", () => {
		// A clock that jumps past the deadline once the scan is under way.
		let calls = 0
		const now = () => {
			calls++
			return calls <= 1 ? 0 : HISTORY_SEARCH_DEFAULTS.MAX_SEARCH_MILLIS + 1
		}

		const lines = Array.from({ length: HISTORY_SEARCH_DEFAULTS.BUDGET_CHECK_INTERVAL * 3 }, () => "needle")
		const outcome = searchHistorySources(
			[{ label: "artifact prune-1000.txt", text: lines.join("\n"), timestamp: 1_000, order: 0 }],
			"needle",
			10,
			{ messageCount: 0, artifactCount: 1, now },
		)

		expect(outcome.timedOut).toBe(true)
		expect(outcome.hits).toHaveLength(0)

		const text = formatHistorySearchOutcome(outcome, "needle")
		expect(text).toContain("too expensive")
		expect(text).toContain("simplify the pattern")
	})

	it("finishes a pathological pattern immediately instead of hanging", () => {
		// Reviewer repro: (a+)+b over a corpus of long runs of a's. Compiled as a
		// regular expression this is exponential; refused, it is instant.
		const messages = [message("user", "a".repeat(2_000), 1_000), message("user", "a".repeat(2_000), 2_000)]

		const started = Date.now()
		const result = search(messages, [], "(a+)+b")
		const elapsed = Date.now() - started

		expect(elapsed).toBeLessThan(1_000)
		expect(result).toContain("No match")
		expect(result).toContain("exponential time")
	}, 10_000)

	it("tests only the first characters of an enormous single line", () => {
		const line = `${"z".repeat(HISTORY_SEARCH_DEFAULTS.MAX_TESTED_LINE_CHARS + 500)}NEEDLE`

		expect(search([message("user", line, 1_000)], [], "NEEDLE")).toContain("No match")
		expect(search([message("user", `NEEDLE ${line}`, 1_000)], [], "NEEDLE")).toContain("matched 1 line(s)")
	})
})

describe("empty or unreadable history", () => {
	it("says the history could not be read instead of suggesting a narrower query", () => {
		const result = search([], [], "anything")

		expect(result).toContain("no stored history to search")
		expect(result).toContain("will not help")
		expect(result).not.toContain("Try a shorter")
	})

	it("still gives the narrow-your-query advice when the corpus is real but has no match", () => {
		const result = search([message("user", "something", 1_000)], [], "anything")

		expect(result).toContain("No match")
		expect(result).toContain("Try a shorter")
	})
})

describe("clampMaxResults", () => {
	it("defaults when the model sends nothing usable", () => {
		expect(clampMaxResults(undefined)).toBe(HISTORY_SEARCH_DEFAULTS.DEFAULT_MAX_RESULTS)
		expect(clampMaxResults(Number.NaN)).toBe(HISTORY_SEARCH_DEFAULTS.DEFAULT_MAX_RESULTS)
	})

	it("clamps into [1, 50]", () => {
		expect(clampMaxResults(0)).toBe(1)
		expect(clampMaxResults(-5)).toBe(1)
		expect(clampMaxResults(7)).toBe(7)
		expect(clampMaxResults(9_999)).toBe(HISTORY_SEARCH_DEFAULTS.MAX_MAX_RESULTS)
	})
})

describe("source building", () => {
	it("labels a message with its index, role and timestamp", () => {
		const [source] = messageSearchSources([message("assistant", "hello", 1_700_000_000_000)])

		expect(source.label).toBe("message 0 (assistant) at 2023-11-14T22:13:20.000Z")
	})

	it("skips messages that carry no searchable text", () => {
		const sources = messageSearchSources([
			{ role: "user", ts: 1_000, content: [] } as ApiMessage,
			message("user", "text", 2_000),
		])

		expect(sources).toHaveLength(1)
		expect(sources[0].label).toContain("message 1")
	})

	it("dates an artifact from the timestamp inside its id", () => {
		const [source] = artifactSearchSources([{ id: "prune-1700000000000.txt", text: "body" }])

		expect(source.timestamp).toBe(1_700_000_000_000)
		expect(source.label).toBe("artifact prune-1700000000000.txt")
	})

	it("says so when an artifact was only scanned in part", () => {
		const [source] = artifactSearchSources([{ id: "cmd-1700000000000.txt", text: "body", truncated: true }])

		expect(source.label).toContain("scanned partially")
	})
})

describe("formatHistorySearchOutcome", () => {
	it("does not suggest raising max_results when nothing was omitted", () => {
		const outcome = searchHistorySources(messageSearchSources([message("user", "one hit", 1_000)]), "hit", 10, {
			messageCount: 1,
			artifactCount: 0,
		})

		expect(formatHistorySearchOutcome(outcome, "hit")).not.toContain("older match(es) are not shown")
	})

	it("never emits an em dash or an en dash", () => {
		const outcome = searchHistorySources(messageSearchSources([message("user", "one hit", 1_000)]), "hit", 10)

		expect(formatHistorySearchOutcome(outcome, "hit")).not.toMatch(/[\u2013\u2014]/)
	})
})

describe("readTaskArtifacts", () => {
	let taskDir: string

	beforeEach(() => {
		taskDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-task-history-"))
	})

	afterEach(() => {
		fs.rmSync(taskDir, { recursive: true, force: true })
	})

	it("returns nothing when the task never wrote an artifact", async () => {
		await expect(readTaskArtifacts(taskDir)).resolves.toEqual([])
	})

	it("reads both artifact directories and ignores foreign files", async () => {
		fs.mkdirSync(path.join(taskDir, "artifacts"), { recursive: true })
		fs.mkdirSync(path.join(taskDir, "command-output"), { recursive: true })
		fs.writeFileSync(path.join(taskDir, "artifacts", "prune-1700000000001.txt"), "pruned body", "utf8")
		fs.writeFileSync(path.join(taskDir, "command-output", "cmd-1700000000002.txt"), "command body", "utf8")
		fs.writeFileSync(path.join(taskDir, "artifacts", "notes.md"), "not an artifact", "utf8")

		const artifacts = await readTaskArtifacts(taskDir)
		const ids = artifacts.map((artifact) => artifact.id).sort()

		expect(ids).toEqual(["cmd-1700000000002.txt", "prune-1700000000001.txt"])
		expect(artifacts.find((a) => a.id === "prune-1700000000001.txt")?.text).toBe("pruned body")
	})

	it("stops at the per-file scan cap and flags the artifact as partial", async () => {
		fs.mkdirSync(path.join(taskDir, "artifacts"), { recursive: true })
		const oversized = "y".repeat(HISTORY_SEARCH_DEFAULTS.MAX_ARTIFACT_SCAN_BYTES + 1_000)
		fs.writeFileSync(path.join(taskDir, "artifacts", "tool-1700000000003.txt"), oversized, "utf8")

		const [artifact] = await readTaskArtifacts(taskDir)

		expect(artifact.truncated).toBe(true)
		expect(artifact.text.length).toBe(HISTORY_SEARCH_DEFAULTS.MAX_ARTIFACT_SCAN_BYTES)
	})

	it("feeds the search: a match found only on disk comes back with its artifact id", async () => {
		fs.mkdirSync(path.join(taskDir, "artifacts"), { recursive: true })
		fs.writeFileSync(
			path.join(taskDir, "artifacts", "prune-1700000000004.txt"),
			"before\nthe answer is 42\nafter",
			"utf8",
		)

		const artifacts = await readTaskArtifacts(taskDir)
		const result = searchTaskHistoryCorpus({ messages: [], artifacts, query: "answer is \\d+" }).text

		expect(result).toContain("the answer is 42")
		expect(result).toContain("artifact prune-1700000000004.txt")
	})
})
