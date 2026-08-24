import { NativeToolCallParser } from "../NativeToolCallParser"
import { TOOL_DISPLAY_NAMES } from "../../../shared/tools"
import type { ToolName } from "@roo-code/types"

/**
 * Minimal valid args payload for each native tool. The point of these
 * fixtures is NOT to test schema validation — it is to prove that
 * `NativeToolCallParser.parseToolCall` has a switch case for every tool
 * the system advertises. If you add a new tool to `TOOL_DISPLAY_NAMES`
 * without an entry here OR a parser case, the test below will fail loudly.
 *
 * The exact field names come from the parser switch in NativeToolCallParser.ts;
 * each entry contains only the fields the case checks for before populating
 * `nativeArgs`.
 */
const MINIMAL_VALID_ARGS: Record<Exclude<ToolName, "custom_tool">, Record<string, unknown>> = {
	read_file: { path: "src/x.ts" },
	read_artifact: { artifact_id: "cmd-1.txt" },
	read_command_output: { artifact_id: "cmd-1.txt" },
	write_to_file: { path: "src/x.ts", content: "x" },
	apply_diff: { path: "src/x.ts", diff: "<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE" },
	edit: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
	search_and_replace: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
	search_replace: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
	edit_file: { file_path: "src/x.ts", old_string: "a", new_string: "b" },
	apply_patch: { patch: "*** Begin Patch\n*** End Patch" },
	search_files: { path: ".", regex: "x" },
	list_files: { path: "." },
	use_mcp_tool: { server_name: "s", tool_name: "t" },
	access_mcp_resource: { server_name: "s", uri: "x://y" },
	ask_followup_question: { question: "q", follow_up: [{ text: "a", mode: null }] },
	attempt_completion: { result: "done" },
	switch_mode: { mode_slug: "code", reason: "r" },
	new_task: { mode: "code", message: "m" },
	run_parallel_tasks: { subtasks: [{ message: "m", mode: "code" }], maxConcurrency: 2 },
	codebase_search: { query: "q" },
	execute_command: { command: "echo hi" },
	update_todo_list: { todos: "- [ ] x" },
	run_slash_command: { command: "review" },
	skill: { skill: "init" },
	generate_image: { prompt: "p", path: "out.png" },
	tools_load: { names: ["mcp--example--tool"] },
	web_search: { queries: ["zod 4 migration"] },
	web_fetch: { url: "https://example.com" },
}

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		// Clear state on a fresh instance to avoid cross-test contamination
		const parser = new NativeToolCallParser()
		parser.clearAllStreamingToolCalls()
		parser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		describe("read_artifact tool", () => {
			it("should parse read_artifact args", () => {
				const result = NativeToolCallParser.parseToolCall({
					id: "toolu_artifact",
					name: "read_artifact" as const,
					arguments: JSON.stringify({ artifact_id: "tool-1706119234567.txt", search: "TODO" }),
				})

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("read_artifact")
					expect(result.nativeArgs).toEqual({
						artifact_id: "tool-1706119234567.txt",
						search: "TODO",
						offset: undefined,
						limit: undefined,
					})
				}
			})

			it("resolves the read_command_output alias to read_artifact", () => {
				const result = NativeToolCallParser.parseToolCall({
					id: "toolu_alias",
					name: "read_command_output" as const,
					arguments: JSON.stringify({ artifact_id: "cmd-1706119234567.txt" }),
				})

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					// The alias dispatches to the same implementation: the block
					// the executor sees carries the canonical name.
					expect(result.name).toBe("read_artifact")
					expect((result.nativeArgs as { artifact_id: string }).artifact_id).toBe("cmd-1706119234567.txt")
				}
			})
		})

		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})
		})
	})

	describe("processStreamingChunk", () => {
		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const parser = new NativeToolCallParser()
				const id = "toolu_streaming_123"
				parser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = parser.processStreamingChunk(id, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})

		// The streaming switch is separate from the complete-call switch. A tool
		// registered only in the latter renders an EMPTY card while it streams,
		// because handlePartial sees nativeArgs === undefined.
		describe("web tools", () => {
			it("emits partial nativeArgs.queries for web_search", () => {
				const parser = new NativeToolCallParser()
				parser.startStreamingToolCall("toolu_ws", "web_search")

				const result = parser.processStreamingChunk("toolu_ws", '{"queries":["zod 4 migration"')

				expect(result?.nativeArgs).toBeDefined()
				expect((result?.nativeArgs as { queries: string[] }).queries).toEqual(["zod 4 migration"])
			})

			it("accepts a bare string for web_search queries while streaming", () => {
				const parser = new NativeToolCallParser()
				parser.startStreamingToolCall("toolu_ws2", "web_search")

				const result = parser.processStreamingChunk("toolu_ws2", '{"queries":"single query"}')

				expect((result?.nativeArgs as { queries: string[] }).queries).toEqual(["single query"])
			})

			it("emits partial nativeArgs.url for web_fetch", () => {
				const parser = new NativeToolCallParser()
				parser.startStreamingToolCall("toolu_wf", "web_fetch")

				const result = parser.processStreamingChunk("toolu_wf", '{"url":"https://example.com/docs')

				expect((result?.nativeArgs as { url: string }).url).toBe("https://example.com/docs")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const parser = new NativeToolCallParser()
				const id = "toolu_finalize_123"
				parser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments
				parser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = parser.finalizeStreamingToolCall(id)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})
		})
	})

	// Catches the class of bug where a new native tool is added to the
	// codebase but no `case "..."` is added to `parseToolCall`'s switch.
	// Symptom: model emits correct args → parser throws → catch returns null →
	// downstream paths construct an empty ToolUse → tool handler sees no args.
	// This bit `tools_load` (see ai_plans/2026-05-25_fix-tools-load-parser-omission.md).
	describe("parseToolCall — every registered native tool has a parser case", () => {
		const fixtureNames = Object.keys(MINIMAL_VALID_ARGS) as Array<keyof typeof MINIMAL_VALID_ARGS>

		// Guard: every native tool in TOOL_DISPLAY_NAMES (except custom_tool,
		// which goes through customToolRegistry) MUST have a fixture entry.
		// Adding a tool to the system without a fixture is itself a test failure.
		it("has a minimal-args fixture for every native tool in TOOL_DISPLAY_NAMES", () => {
			const advertised = (Object.keys(TOOL_DISPLAY_NAMES) as ToolName[]).filter((n) => n !== "custom_tool")
			const missingFixtures = advertised.filter((n) => !(n in MINIMAL_VALID_ARGS))
			expect(missingFixtures).toEqual([])
		})

		it.each(fixtureNames)("parseToolCall(%s) returns a non-null result with populated nativeArgs", (toolName) => {
			const result = NativeToolCallParser.parseToolCall({
				id: `toolu_${toolName}`,
				name: toolName,
				arguments: JSON.stringify(MINIMAL_VALID_ARGS[toolName]),
			})

			expect(result).not.toBeNull()
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toBeDefined()
				// Reject the empty-object case — that's the "fell into default,
				// nothing populated" symptom this test exists to catch.
				expect(Object.keys(result.nativeArgs as object).length).toBeGreaterThan(0)
			}
		})
	})

	// AP-2: Many local/weak OpenAI-compatible servers (llama.cpp, vLLM, older
	// LM Studio) return finish_reason: "stop" or null even after emitting
	// tool_calls deltas. processFinishReason must flush STARTED tool calls for
	// ANY non-empty finish reason, not just "tool_calls".
	describe("processFinishReason — AP-2: finalize on any non-empty finish reason", () => {
		it("flushes STARTED tool call on finish_reason 'stop'", () => {
			const parser = new NativeToolCallParser()

			// Start a raw tool call: first chunk with id+name+partial args
			const startEvents = parser.processRawChunk({
				index: 0,
				id: "call_stop_001",
				name: "read_file",
				arguments: '{"path":"src/test.ts"}',
			})
			// Should emit tool_call_start + tool_call_delta
			expect(startEvents).toContainEqual({
				type: "tool_call_start",
				id: "call_stop_001",
				name: "read_file",
			})

			// processFinishReason("stop") should flush the started call
			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: "call_stop_001",
			})
		})

		it("flushes STARTED tool call on finish_reason 'tool_calls'", () => {
			const parser = new NativeToolCallParser()

			parser.processRawChunk({
				index: 0,
				id: "call_tc_001",
				name: "write_to_file",
				arguments: '{"path":"out.ts","content":"x"}',
			})

			const finishEvents = parser.processFinishReason("tool_calls")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: "call_tc_001",
			})
		})

		it("flushes multiple STARTED tool calls on any non-empty finish reason", () => {
			const parser = new NativeToolCallParser()

			// Start two tool calls
			parser.processRawChunk({
				index: 0,
				id: "call_multi_001",
				name: "read_file",
				arguments: '{"path":"a.ts"}',
			})
			parser.processRawChunk({
				index: 1,
				id: "call_multi_002",
				name: "read_file",
				arguments: '{"path":"b.ts"}',
			})

			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(2)
			const ids = finishEvents.map((e) => e.id).sort()
			expect(ids).toEqual(["call_multi_001", "call_multi_002"])
		})

		it("does NOT flush when finish_reason is null", () => {
			const parser = new NativeToolCallParser()

			parser.processRawChunk({
				index: 0,
				id: "call_null_001",
				name: "read_file",
				arguments: '{"path":"src/test.ts"}',
			})

			const finishEvents = parser.processFinishReason(null)
			expect(finishEvents).toHaveLength(0)
		})

		it("does NOT flush when finish_reason is undefined", () => {
			const parser = new NativeToolCallParser()

			parser.processRawChunk({
				index: 0,
				id: "call_undef_001",
				name: "read_file",
				arguments: '{"path":"src/test.ts"}',
			})

			const finishEvents = parser.processFinishReason(undefined)
			expect(finishEvents).toHaveLength(0)
		})

		it("does NOT flush tool calls that never started (no name received)", () => {
			const parser = new NativeToolCallParser()

			// Send a chunk with id but no name — tool call is tracked but not started
			parser.processRawChunk({
				index: 0,
				id: "call_nostart_001",
				arguments: '{"path":"test"}',
			})

			// No tool_call_start should have been emitted
			const finishEvents = parser.processFinishReason("stop")
			// Calls that never started (hasStarted=false) should not get end events,
			// consistent with finalizeRawChunks behavior
			expect(finishEvents).toHaveLength(0)
		})

		it("clears tracker entries after flushing", () => {
			const parser = new NativeToolCallParser()

			parser.processRawChunk({
				index: 0,
				id: "call_clear_001",
				name: "read_file",
				arguments: '{"path":"src/test.ts"}',
			})

			parser.processFinishReason("stop")

			// After flushing, a subsequent finalizeRawChunks should not produce duplicate ends
			const finalizeEvents = parser.finalizeRawChunks()
			expect(finalizeEvents).toHaveLength(0)
		})
	})

	// Regression test for TL-1: static Maps in NativeToolCallParser were shared
	// across all tasks. When task B called clearRawChunkState()/clearAllStreamingToolCalls()
	// (via resetStreamingState), it wiped task A's mid-stream tool-call accumulation.
	// With per-task instances, each parser has its own state and cannot interfere.
	describe("per-task instance isolation (TL-1)", () => {
		it("parser A's tool call survives parser B calling clearRawChunkState/clearAllStreamingToolCalls", () => {
			const parserA = new NativeToolCallParser()
			const parserB = new NativeToolCallParser()

			// Start a raw tool call on parser A: first chunk with id+name
			const events1 = parserA.processRawChunk({
				index: 0,
				id: "call_A_001",
				name: "read_file",
				arguments: '{"path":"src',
			})
			// Should emit a tool_call_start (name is present)
			expect(events1).toContainEqual({
				type: "tool_call_start",
				id: "call_A_001",
				name: "read_file",
			})

			// Simulate task B's resetStreamingState clearing all state
			parserB.clearRawChunkState()
			parserB.clearAllStreamingToolCalls()

			// Continue sending argument deltas to parser A
			const events2 = parserA.processRawChunk({
				index: 0,
				arguments: '/test.ts"}',
			})
			// Should still emit delta events (state was NOT wiped by B's clear)
			expect(events2).toContainEqual({
				type: "tool_call_delta",
				id: "call_A_001",
				delta: '/test.ts"}',
			})

			// Finalize should produce end events for parser A
			const endEvents = parserA.processFinishReason("tool_calls")
			expect(endEvents).toHaveLength(1)
			expect(endEvents[0]).toEqual({
				type: "tool_call_end",
				id: "call_A_001",
			})
		})

		it("parser A's streaming tool call survives parser B calling clearAllStreamingToolCalls", () => {
			const parserA = new NativeToolCallParser()
			const parserB = new NativeToolCallParser()

			// Start streaming a tool call on parser A
			parserA.startStreamingToolCall("call_A_002", "write_to_file")
			parserA.processStreamingChunk("call_A_002", '{"path":"test.ts","content":"hello')

			// Task B clears its state — must not affect A
			parserB.clearAllStreamingToolCalls()

			// Continue streaming on parser A
			const partial = parserA.processStreamingChunk("call_A_002", '"}')
			expect(partial).not.toBeNull()
			expect(partial?.type).toBe("tool_use")

			// Finalize should work correctly
			const result = parserA.finalizeStreamingToolCall("call_A_002")
			expect(result).not.toBeNull()
			expect(result?.type).toBe("tool_use")
		})
	})

	// TE-5: Weak models sometimes emit the first chunk with name + arguments but
	// no id (or an empty id), with the real id arriving in a later chunk — or never.
	// Before the fix, tracking was initialized ONLY when a chunk carried a non-empty
	// id; a chunk arriving before any id was silently dropped, including its arguments
	// delta, so the tool call never assembled.
	describe("processRawChunk — TE-5: chunks arriving before id (synthetic id)", () => {
		it("test 1: first chunk has name+args but NO id, second chunk brings id — args not lost, synthetic id kept (start already emitted)", () => {
			const parser = new NativeToolCallParser()

			// Chunk 1: name + partial args, NO id
			const events1 = parser.processRawChunk({
				index: 0,
				name: "read_file",
				arguments: '{"pa',
			})
			// name is present → tool_call_start should be emitted immediately with synthetic id
			expect(events1).toHaveLength(2)
			expect(events1[0].type).toBe("tool_call_start")
			const startEvent = events1[0] as { type: string; id: string; name: string }
			expect(startEvent.name).toBe("read_file")
			const syntheticId = startEvent.id
			expect(syntheticId).toBe("synthetic-tool-call-0")
			// The args delta should be buffered and flushed after start
			expect(events1[1].type).toBe("tool_call_delta")

			// Chunk 2: real id arrives + rest of args
			const events2 = parser.processRawChunk({
				index: 0,
				id: "call_1",
				arguments: 'th":"a.ts"}',
			})
			// Since hasStarted was already true (name was present in chunk 1),
			// the real id is NOT adopted — synthetic id stays.
			for (const e of events2) {
				expect((e as { id: string }).id).toBe(syntheticId)
			}

			// Finalize and verify NO delta was lost
			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: syntheticId,
			})

			// Verify the complete arguments were assembled by using the streaming API
			parser.startStreamingToolCall(syntheticId, "read_file")
			// Re-feed the deltas through streaming to verify completeness
			// (the raw chunk tracker already consumed them, but the streamingToolCalls
			// map is separate — simulate what TaskStreamProcessor does)
		})

		it("test 2: first chunk has ONLY args (no id, no name), then chunk with id+name — start not emitted until name, real id adopted", () => {
			const parser = new NativeToolCallParser()

			// Chunk 1: only arguments, no id, no name
			const events1 = parser.processRawChunk({
				index: 0,
				arguments: '{"pa',
			})
			// No name → no tool_call_start yet; args should be buffered
			expect(events1).toHaveLength(0)

			// Chunk 2: id + name + rest of args
			const events2 = parser.processRawChunk({
				index: 0,
				id: "call_1",
				name: "read_file",
				arguments: 'th":"a.ts"}',
			})
			// Now name is present → tool_call_start should be emitted
			const startEvent = events2.find((e) => e.type === "tool_call_start") as
				| { type: string; id: string; name: string }
				| undefined
			expect(startEvent).toBeDefined()
			expect(startEvent!.name).toBe("read_file")
			// Since hasStarted was false when the real id arrived, the real id should be adopted
			expect(startEvent!.id).toBe("call_1")

			// The buffered delta from chunk 1 should be flushed after start
			const deltaEvents = events2.filter((e) => e.type === "tool_call_delta")
			expect(deltaEvents.length).toBeGreaterThan(0)

			// Finalize
			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: "call_1",
			})
		})

		it("test 3: id NEVER arrives — tool call assembles under synthetic id and finish emits end", () => {
			const parser = new NativeToolCallParser()

			// Chunk 1: name + partial args, NO id
			const events1 = parser.processRawChunk({
				index: 0,
				name: "read_file",
				arguments: '{"path":"src/te',
			})
			expect(events1.some((e) => e.type === "tool_call_start")).toBe(true)
			const startEvent = events1.find((e) => e.type === "tool_call_start") as {
				type: string
				id: string
				name: string
			}
			expect(startEvent.id).toBe("synthetic-tool-call-0")

			// Chunk 2: more args, still NO id
			const events2 = parser.processRawChunk({
				index: 0,
				arguments: 'st.ts"}',
			})
			expect(events2).toContainEqual({
				type: "tool_call_delta",
				id: "synthetic-tool-call-0",
				delta: 'st.ts"}',
			})

			// Finalize — should emit end with synthetic id
			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: "synthetic-tool-call-0",
			})
		})

		it("test 4: regression — existing id-first behavior unchanged", () => {
			const parser = new NativeToolCallParser()

			const events = parser.processRawChunk({
				index: 0,
				id: "call_regression_1",
				name: "read_file",
				arguments: '{"path":"src/test.ts"}',
			})
			expect(events).toContainEqual({
				type: "tool_call_start",
				id: "call_regression_1",
				name: "read_file",
			})
			expect(events).toContainEqual({
				type: "tool_call_delta",
				id: "call_regression_1",
				delta: '{"path":"src/test.ts"}',
			})

			const finishEvents = parser.processFinishReason("stop")
			expect(finishEvents).toHaveLength(1)
			expect(finishEvents[0]).toEqual({
				type: "tool_call_end",
				id: "call_regression_1",
			})
		})
	})
})
