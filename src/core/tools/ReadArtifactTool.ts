import * as fs from "fs/promises"
import * as path from "path"

import { resolveMaxInlineToolResultBytes } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { getTaskDirectoryPath } from "../../utils/storage"
import { artifactCandidatePaths, isValidArtifactId } from "../artifacts/ArtifactStore"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Corrective guidance appended to every artifact-id error.
 *
 * Weak models guess ids when a lookup fails, which burns turns. Spelling out
 * the shape of a valid id and the recovery move (re-run the producer) is
 * cheaper than another round of guessing.
 */
const ARTIFACT_ID_GUIDANCE =
	'Valid ids look like "cmd-1706119234567.txt" (full output of an execute_command run), ' +
	'"tool-1706119234567.txt" (a tool result that was too large to keep inline) or ' +
	'"prune-1706119234567.txt" (an older tool result moved to disk to free context). ' +
	"Copy the id verbatim from the message that announced it instead of constructing one. " +
	"If no message announced an artifact, re-run the command or the tool that produced the output."

/**
 * Parameters accepted by the read_artifact tool.
 */
interface ReadArtifactParams {
	/**
	 * The artifact file identifier (e.g., "cmd-1706119234567.txt" or
	 * "tool-1706119234567.txt"). Announced by the message that created the
	 * artifact: a truncated execute_command result, or a spilled tool result.
	 */
	artifact_id: string
	/**
	 * Optional search pattern (regex or literal string) to filter lines.
	 * When provided, only lines matching the pattern are returned.
	 */
	search?: string
	/**
	 * Byte offset to start reading from (default: 0).
	 * Used for paginating through large outputs.
	 */
	offset?: number
	/**
	 * Maximum bytes to return. Defaults to (and is capped by) the same inline
	 * budget the spill policy enforces, so one read cannot re-inject more than
	 * the budget the spill was meant to protect.
	 */
	limit?: number
}

/**
 * ReadArtifactTool lets the LLM retrieve text that was too large to keep inline.
 *
 * Three producers write artifacts:
 *
 * - `execute_command`, whose full output the `OutputInterceptor` streams to a
 *   `cmd-*.txt` artifact once it passes the terminal preview threshold.
 * - the tool-result spill policy, which moves any oversized tool result to a
 *   `tool-*.txt` artifact and leaves a head/tail preview in the conversation.
 * - the deterministic pruner, which under context pressure moves an OLD tool
 *   result to a `prune-*.txt` artifact and leaves a head/tail preview behind.
 *
 * In every case this tool provides:
 *
 * 1. **Read full text**: retrieve content beyond the preview
 * 2. **Search**: filter lines matching a pattern (like grep)
 * 3. **Paginate**: read in chunks using offset/limit
 *
 * ## Storage Location
 *
 * Artifacts are stored outside the workspace in the task directory:
 * `globalStoragePath/tasks/{taskId}/command-output/cmd-{ts}.txt` and
 * `globalStoragePath/tasks/{taskId}/artifacts/{kind}-{ts}.txt`.
 *
 * ## Security
 *
 * The tool validates artifact_id format to prevent path traversal attacks.
 * Only files matching `{kind}-{digits}.txt` are accessible, and only inside
 * the current task's own artifact directories.
 *
 * ## Usage Flow
 *
 * 1. A tool call produces more output than fits inline
 * 2. The result message quotes an `artifact_id`
 * 3. LLM calls `read_artifact` with that id to get the rest
 *
 * @example
 * ```typescript
 * // Basic usage - read from beginning
 * await readArtifactTool.execute({
 *   artifact_id: "cmd-1706119234567.txt"
 * }, task, callbacks);
 *
 * // Search for specific content in a spilled tool result
 * await readArtifactTool.execute({
 *   artifact_id: "tool-1706119234567.txt",
 *   search: "error|failed"
 * }, task, callbacks);
 *
 * // Paginate through large output
 * await readArtifactTool.execute({
 *   artifact_id: "cmd-1706119234567.txt",
 *   offset: 32768,  // Start after first 32KB
 *   limit: 32768    // Read next 32KB
 * }, task, callbacks);
 * ```
 */
export class ReadArtifactTool extends BaseTool<"read_artifact"> {
	readonly name = "read_artifact" as const

	/**
	 * Execute the read_artifact tool.
	 *
	 * Reads a persisted artifact from disk, supporting both full reads and
	 * search-based filtering. Results include line numbers for easy reference.
	 *
	 * @param params - The tool parameters including artifact_id and optional search/pagination
	 * @param task - The current task instance for error reporting and state management
	 * @param callbacks - Callbacks for pushing tool results
	 */
	async execute(params: ReadArtifactParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult } = callbacks
		const { artifact_id, search, offset = 0 } = params

		// Validate required parameters
		if (!artifact_id) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_artifact")
			task.didToolFailInCurrentTurn = true
			const errorMsg = await task.sayAndCreateMissingParamError("read_artifact", "artifact_id")
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		// Validate artifact_id format to prevent path traversal
		if (!isValidArtifactId(artifact_id)) {
			task.consecutiveMistakeCount++
			task.recordToolError("read_artifact")
			task.didToolFailInCurrentTurn = true
			const errorMsg = `Invalid artifact_id format: "${artifact_id}". ${ARTIFACT_ID_GUIDANCE}`
			await task.say("error", errorMsg)
			pushToolResult(`Error: ${errorMsg}`)
			return
		}

		try {
			// Get the task directory path
			const provider = await task.providerRef.deref()
			const globalStoragePath = provider?.context?.globalStorageUri?.fsPath

			// The read window is bounded by the SAME budget the spill policy
			// enforces (`maxInlineToolResultBytes`, default 24 KB). Reading back
			// more than that would defeat the policy in a single call, so the
			// requested limit is clamped rather than trusted.
			const state = await provider?.getState?.()
			const maxInlineBytes = resolveMaxInlineToolResultBytes(state)
			const limit = Math.max(1, Math.min(params.limit ?? maxInlineBytes, maxInlineBytes))

			if (!globalStoragePath) {
				const errorMsg = "Unable to access artifact storage. Global storage path is not available."
				await task.say("error", errorMsg)
				pushToolResult(`Error: ${errorMsg}`)
				return
			}

			const taskDir = await getTaskDirectoryPath(globalStoragePath, task.taskId)

			// Probe every directory an artifact of this kind may live in: `cmd`
			// artifacts kept their historical `command-output` directory, newer
			// kinds live under `artifacts`.
			let artifactPath: string | undefined
			for (const candidate of artifactCandidatePaths(taskDir, artifact_id)) {
				try {
					await fs.access(candidate)
					artifactPath = candidate
					break
				} catch {
					// Try the next directory.
				}
			}

			if (!artifactPath) {
				const errorMsg = `Artifact not found: "${artifact_id}". ${ARTIFACT_ID_GUIDANCE}`
				await task.say("error", errorMsg)
				task.didToolFailInCurrentTurn = true
				pushToolResult(`Error: ${errorMsg}`)
				return
			}

			// Get file stats for metadata
			const stats = await fs.stat(artifactPath)
			const totalSize = stats.size

			// Validate offset
			if (offset < 0 || offset >= totalSize) {
				const errorMsg = `Invalid offset: ${offset}. File size is ${totalSize} bytes. Offset must be between 0 and ${totalSize - 1}.`
				await task.say("error", errorMsg)
				pushToolResult(`Error: ${errorMsg}`)
				return
			}

			let result: string
			let readStart = 0
			let readEnd = 0
			let matchCount: number | undefined

			if (search) {
				// Search mode: filter lines matching the pattern
				const searchResult = await this.searchInArtifact(artifactPath, search, totalSize, limit)
				result = searchResult.content
				matchCount = searchResult.matchCount
				// For search, we're scanning the whole file
				readStart = 0
				readEnd = totalSize
			} else {
				// Normal read mode with offset/limit
				result = await this.readArtifact(artifactPath, offset, limit, totalSize)
				// Calculate actual read range
				readStart = offset
				readEnd = Math.min(offset + limit, totalSize)
			}

			// Report to UI that we read an artifact
			await task.say(
				"tool",
				JSON.stringify({
					tool: "readArtifact",
					readStart,
					readEnd,
					totalBytes: totalSize,
					...(search && { searchPattern: search, matchCount }),
				}),
			)

			task.consecutiveMistakeCount = 0
			pushToolResult(result)
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error)
			await task.say("error", `Error reading artifact: ${errorMsg}`)
			task.didToolFailInCurrentTurn = true
			// The envelope, not a bare string: the model gets `failed_tool` plus this tool's
			// minimal valid call, which is what a weak model needs when it guessed the id.
			pushToolResult(formatResponse.toolError(`Error reading artifact: ${errorMsg}`, this.name))
		}
	}

	/**
	 * Read artifact content with offset and limit, adding line numbers.
	 *
	 * Performs efficient partial file reads using file handles and positional
	 * reads. Line numbers are calculated by counting newlines in the portion
	 * of the file before the offset.
	 *
	 * @param artifactPath - Absolute path to the artifact file
	 * @param offset - Byte offset to start reading from
	 * @param limit - Maximum bytes to read
	 * @param totalSize - Total size of the file in bytes
	 * @returns Formatted output with header metadata and line-numbered content
	 * @private
	 */
	private async readArtifact(
		artifactPath: string,
		offset: number,
		limit: number,
		totalSize: number,
	): Promise<string> {
		const fileHandle = await fs.open(artifactPath, "r")

		try {
			const buffer = Buffer.alloc(Math.min(limit, totalSize - offset))
			const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, offset)
			const content = buffer.slice(0, bytesRead).toString("utf8")

			// Calculate line numbers based on offset using chunked reading to avoid large allocations
			let startLineNumber = 1
			if (offset > 0) {
				startLineNumber = await this.countNewlinesBeforeOffset(fileHandle, offset)
			}

			const endOffset = offset + bytesRead
			const truncated = endOffset < totalSize
			const artifactId = path.basename(artifactPath)

			// Add line numbers to content
			const numberedContent = this.addLineNumbers(content, startLineNumber)

			const header = [
				`[Artifact: ${artifactId}]`,
				`Total size: ${this.formatBytes(totalSize)} | Showing bytes ${offset}-${endOffset} | ${truncated ? "TRUNCATED" : "COMPLETE"}`,
				"",
			].join("\n")

			return header + numberedContent
		} finally {
			await fileHandle.close()
		}
	}

	/**
	 * Search artifact content for lines matching a pattern using chunked streaming.
	 *
	 * Performs grep-like searching through the artifact file using bounded memory.
	 * Instead of loading the entire file into memory, this reads in fixed-size chunks
	 * and processes lines as they are encountered. This keeps memory usage predictable
	 * even for very large command outputs (e.g., 100MB+ build logs).
	 *
	 * The pattern is treated as a case-insensitive regex. If the pattern is invalid
	 * regex syntax, it's escaped and treated as a literal string.
	 *
	 * Results are limited by the byte limit to prevent excessive output.
	 *
	 * @param artifactPath - Absolute path to the artifact file
	 * @param pattern - Search pattern (regex or literal string)
	 * @param totalSize - Total size of the file in bytes (for display)
	 * @param limit - Maximum bytes of matching content to return
	 * @returns Formatted output with matching lines and their line numbers
	 * @private
	 */
	private async searchInArtifact(
		artifactPath: string,
		pattern: string,
		totalSize: number,
		limit: number,
	): Promise<{ content: string; matchCount: number }> {
		const CHUNK_SIZE = 64 * 1024 // 64KB chunks for bounded memory

		// Create case-insensitive regex for search
		let regex: RegExp
		try {
			regex = new RegExp(pattern, "i")
		} catch {
			// If invalid regex, treat as literal string
			regex = new RegExp(this.escapeRegExp(pattern), "i")
		}

		const fileHandle = await fs.open(artifactPath, "r")
		const matches: Array<{ lineNumber: number; content: string }> = []
		let totalMatchBytes = 0
		let lineNumber = 0
		let partialLine = "" // Holds incomplete line from previous chunk
		let bytesRead = 0
		let hitLimit = false

		try {
			while (bytesRead < totalSize && !hitLimit) {
				const chunkSize = Math.min(CHUNK_SIZE, totalSize - bytesRead)
				const buffer = Buffer.alloc(chunkSize)
				const result = await fileHandle.read(buffer, 0, chunkSize, bytesRead)

				if (result.bytesRead === 0) {
					break
				}

				const chunk = buffer.slice(0, result.bytesRead).toString("utf8")
				bytesRead += result.bytesRead

				// Combine with partial line from previous chunk
				const combined = partialLine + chunk
				const lines = combined.split("\n")

				// Last element may be incomplete (no trailing newline), save for next iteration
				partialLine = lines.pop() ?? ""

				// Process complete lines
				for (const line of lines) {
					lineNumber++

					if (regex.test(line)) {
						const lineBytes = Buffer.byteLength(line, "utf8")

						// Stop if we've exceeded the byte limit
						if (totalMatchBytes + lineBytes > limit) {
							hitLimit = true
							break
						}

						matches.push({ lineNumber, content: line })
						totalMatchBytes += lineBytes
					}
				}
			}

			// Process any remaining partial line at end of file
			if (!hitLimit && partialLine.length > 0) {
				lineNumber++
				if (regex.test(partialLine)) {
					const lineBytes = Buffer.byteLength(partialLine, "utf8")
					if (totalMatchBytes + lineBytes <= limit) {
						matches.push({ lineNumber, content: partialLine })
					}
				}
			}
		} finally {
			await fileHandle.close()
		}

		const artifactId = path.basename(artifactPath)

		if (matches.length === 0) {
			const content = [
				`[Artifact: ${artifactId}] (search: "${pattern}")`,
				`Total size: ${this.formatBytes(totalSize)}`,
				"",
				"No matches found for the search pattern.",
			].join("\n")
			return { content, matchCount: 0 }
		}

		// Format matches with line numbers
		const matchedLines = matches.map((m) => `${String(m.lineNumber).padStart(5)} | ${m.content}`).join("\n")

		const content = [
			`[Artifact: ${artifactId}] (search: "${pattern}")`,
			`Total matches: ${matches.length} | Showing first ${matches.length}`,
			"",
			matchedLines,
		].join("\n")
		return { content, matchCount: matches.length }
	}

	/**
	 * Add line numbers to content for easier reference.
	 *
	 * Each line is prefixed with its line number, right-padded to align
	 * all line numbers in the output.
	 *
	 * @param content - The text content to add line numbers to
	 * @param startLine - The line number for the first line
	 * @returns Content with line numbers prefixed to each line
	 * @private
	 */
	private addLineNumbers(content: string, startLine: number): string {
		const lines = content.split("\n")
		const maxLineNum = startLine + lines.length - 1
		const padding = String(maxLineNum).length

		return lines.map((line, index) => `${String(startLine + index).padStart(padding)} | ${line}`).join("\n")
	}

	/**
	 * Format a byte count to a human-readable string.
	 *
	 * @param bytes - The byte count to format
	 * @returns Human-readable string (e.g., "1.5KB", "2.3MB")
	 * @private
	 */
	private formatBytes(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} bytes`
		}
		if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)}KB`
		}
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
	}

	/**
	 * Escape special regex characters in a string for literal matching.
	 *
	 * @param string - The string to escape
	 * @returns The escaped string safe for use in a RegExp constructor
	 * @private
	 */
	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	}

	/**
	 * Count newlines before a given byte offset using fixed-size chunks.
	 *
	 * This avoids allocating a buffer of size `offset` which could be huge
	 * for large files. Instead, we read in 64KB chunks and count newlines.
	 *
	 * @param fileHandle - Open file handle for reading
	 * @param offset - The byte offset to count newlines up to
	 * @returns The line number at the given offset (1-indexed)
	 * @private
	 */
	private async countNewlinesBeforeOffset(fileHandle: fs.FileHandle, offset: number): Promise<number> {
		const CHUNK_SIZE = 64 * 1024 // 64KB chunks
		let newlineCount = 0
		let bytesRead = 0

		while (bytesRead < offset) {
			const chunkSize = Math.min(CHUNK_SIZE, offset - bytesRead)
			const buffer = Buffer.alloc(chunkSize)
			const result = await fileHandle.read(buffer, 0, chunkSize, bytesRead)

			if (result.bytesRead === 0) {
				break
			}

			// Count newlines in this chunk
			for (let i = 0; i < result.bytesRead; i++) {
				if (buffer[i] === 0x0a) {
					// '\n'
					newlineCount++
				}
			}

			bytesRead += result.bytesRead
		}

		return newlineCount + 1 // Line numbers are 1-indexed
	}
}

/** Singleton instance of the ReadArtifactTool */
export const readArtifactTool = new ReadArtifactTool()
