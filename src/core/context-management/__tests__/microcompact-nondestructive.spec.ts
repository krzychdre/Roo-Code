// cd src && npx vitest run core/context-management/__tests__/microcompact-nondestructive.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import { ApiMessage } from "../../task-persistence/apiMessages"

import { applyMicrocompactCleared, MICROCOMPACT_CLEARED_PLACEHOLDER } from "../microcompact"

let counter = 0

/** Build an assistant `tool_use` + user `tool_result` pair for a given tool. */
function toolPair(toolName: string, resultContent: string, id?: string): [ApiMessage, ApiMessage] {
	counter += 1
	const useId = id ?? `tool-${counter}`
	const assistant: ApiMessage = {
		role: "assistant",
		content: [{ type: "tool_use", id: useId, name: toolName, input: {} }],
		ts: counter,
	}
	const user: ApiMessage = {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: useId, content: resultContent }],
		ts: counter,
	}
	return [assistant, user]
}

function firstUser(): ApiMessage {
	return { role: "user", content: "Initial task", ts: 0 }
}

/** Find the tool_result content for a given tool_use_id in a message list. */
function resultContentFor(messages: ApiMessage[], toolUseId: string): unknown {
	for (const msg of messages) {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
					return block.content
				}
			}
		}
	}
	return undefined
}

describe("applyMicrocompactCleared (send-time, non-destructive)", () => {
	beforeEach(() => {
		counter = 0
	})

	it("clears only the listed tool_use_ids, leaving the rest raw", () => {
		const messages: ApiMessage[] = [
			firstUser(),
			...toolPair("read_file", "contents A", "read-a"),
			...toolPair("read_file", "contents B", "read-b"),
			...toolPair("read_file", "contents C", "read-c"),
		]

		const result = applyMicrocompactCleared(messages, new Set(["read-a", "read-c"]))

		expect(resultContentFor(result, "read-a")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		expect(resultContentFor(result, "read-c")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		expect(resultContentFor(result, "read-b")).toBe("contents B") // untouched
	})

	it("never mutates the source: stored history stays pristine after a strip", () => {
		const messages: ApiMessage[] = [firstUser(), ...toolPair("read_file", "original contents", "read-x")]

		// Snapshot the exact block reference + content before the strip.
		const sourceBlockBefore = (messages[2].content as Anthropic.Messages.ContentBlockParam[])[0]

		const result = applyMicrocompactCleared(messages, new Set(["read-x"]))

		// The outgoing copy is cleared...
		expect(resultContentFor(result, "read-x")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		// ...but the source message, its content array, and its block are all untouched.
		expect(resultContentFor(messages, "read-x")).toBe("original contents")
		expect((messages[2].content as Anthropic.Messages.ContentBlockParam[])[0]).toBe(sourceBlockBefore)
		expect(result).not.toBe(messages)
		expect(result[2]).not.toBe(messages[2]) // touched message is a fresh object
		expect(result[0]).toBe(messages[0]) // untouched messages keep their reference
	})

	it("is a no-op (same reference) when the cleared set is empty", () => {
		// Empty set is the common case AND the mode-switch case: a wider-window model
		// clears nothing, so the request must carry full fidelity with zero copying.
		const messages: ApiMessage[] = [firstUser(), ...toolPair("read_file", "contents", "read-y")]

		const result = applyMicrocompactCleared(messages, new Set())

		expect(result).toBe(messages) // identical reference — no allocation, cache-stable
		expect(resultContentFor(result, "read-y")).toBe("contents")
	})

	it("is a no-op (same reference) when no message matches a listed id", () => {
		const messages: ApiMessage[] = [firstUser(), ...toolPair("read_file", "contents", "read-z")]

		const result = applyMicrocompactCleared(messages, new Set(["nonexistent-id"]))

		expect(result).toBe(messages)
		expect(resultContentFor(result, "read-z")).toBe("contents")
	})

	it("is idempotent: re-applying over already-cleared content does not double-process", () => {
		const messages: ApiMessage[] = [firstUser(), ...toolPair("read_file", "contents", "read-i")]

		const once = applyMicrocompactCleared(messages, new Set(["read-i"]))
		expect(resultContentFor(once, "read-i")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)

		// Running again on the (already cleared) output is a same-reference no-op:
		// the block is already the placeholder, so nothing is touched.
		const twice = applyMicrocompactCleared(once, new Set(["read-i"]))
		expect(twice).toBe(once)
	})

	it("mode-switch: a narrower set clears more, an empty set restores full fidelity", () => {
		const messages: ApiMessage[] = [
			firstUser(),
			...toolPair("read_file", "contents 1", "read-1"),
			...toolPair("read_file", "contents 2", "read-2"),
		]

		// Narrow-window mode clears both old results...
		const narrow = applyMicrocompactCleared(messages, new Set(["read-1", "read-2"]))
		expect(resultContentFor(narrow, "read-1")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
		expect(resultContentFor(narrow, "read-2")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)

		// ...then a switch to a wide-window mode (empty set) recomputed against the
		// SAME pristine source restores everything — because nothing was persisted.
		const wide = applyMicrocompactCleared(messages, new Set())
		expect(resultContentFor(wide, "read-1")).toBe("contents 1")
		expect(resultContentFor(wide, "read-2")).toBe("contents 2")
	})

	it("only touches tool_result blocks (string/other content messages pass through)", () => {
		const plainUser: ApiMessage = { role: "user", content: "just text", ts: 1 }
		const assistantText: ApiMessage = { role: "assistant", content: "a reply", ts: 2 }
		const messages: ApiMessage[] = [plainUser, assistantText, ...toolPair("read_file", "contents", "read-p")]

		const result = applyMicrocompactCleared(messages, new Set(["read-p"]))

		expect(result[0]).toBe(plainUser) // untouched, same ref
		expect(result[1]).toBe(assistantText) // untouched, same ref
		expect(resultContentFor(result, "read-p")).toBe(MICROCOMPACT_CLEARED_PLACEHOLDER)
	})

	it("keeps the artifact notice of a spilled result in the outgoing copy", () => {
		const notice =
			"[Tool result: 412 KB, showing first 60 and last 60 lines. Full output saved as artifact " +
			'"tool-1706119234567.txt". Use read_artifact (search/offset/limit) to inspect the rest.]'
		const messages: ApiMessage[] = [
			firstUser(),
			...toolPair("search_files", `${notice}\nfirst hit\n...\nlast hit`, "spilled"),
		]

		const result = applyMicrocompactCleared(messages, new Set(["spilled"]))
		const cleared = resultContentFor(result, "spilled") as string

		expect(cleared).toBe(`${notice}\n${MICROCOMPACT_CLEARED_PLACEHOLDER}`)

		// Idempotent: a second pass recognises the kept notice as already cleared.
		expect(applyMicrocompactCleared(result, new Set(["spilled"]))).toBe(result)
	})
})
