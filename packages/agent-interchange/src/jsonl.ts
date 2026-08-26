import { once } from "node:events"
import * as fs from "node:fs"
import { createReadStream } from "node:fs"
import * as readline from "node:readline"

/**
 * JSONL helpers built for files that can be tens of megabytes.
 *
 * A listing must not read a whole session to learn its title, so summaries are
 * assembled from a bounded head and tail slice; only an explicit read streams
 * the file. Every parser here is lenient: a session being written to right now
 * ends in a partial line, and one bad line must not lose the session.
 */

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 128 * 1024

/** Complete lines from the first `bytes` of the file. */
export function readHeadLines(file: string, bytes = HEAD_BYTES): string[] {
	const fd = openOrUndefined(file)

	if (fd === undefined) {
		return []
	}

	try {
		const size = fs.fstatSync(fd).size
		const length = Math.min(bytes, size)
		const buffer = Buffer.alloc(length)
		fs.readSync(fd, buffer, 0, length, 0)
		const lines = buffer.toString("utf8").split("\n")

		// The last line is only complete when we read the whole file.
		if (length < size) {
			lines.pop()
		}

		return lines.filter((line) => line.trim())
	} catch {
		return []
	} finally {
		fs.closeSync(fd)
	}
}

/** Complete lines from the last `bytes` of the file. */
export function readTailLines(file: string, bytes = TAIL_BYTES): string[] {
	const fd = openOrUndefined(file)

	if (fd === undefined) {
		return []
	}

	try {
		const size = fs.fstatSync(fd).size
		const length = Math.min(bytes, size)
		const offset = size - length
		const buffer = Buffer.alloc(length)
		fs.readSync(fd, buffer, 0, length, offset)
		const lines = buffer.toString("utf8").split("\n")

		// When we started mid-file the first line is a fragment.
		if (offset > 0) {
			lines.shift()
		}

		return lines.filter((line) => line.trim())
	} catch {
		return []
	} finally {
		fs.closeSync(fd)
	}
}

/** Parse a JSONL line, or `undefined` when it is truncated or malformed. */
export function parseLine<T = Record<string, unknown>>(line: string): T | undefined {
	try {
		const value = JSON.parse(line) as unknown
		return value && typeof value === "object" ? (value as T) : undefined
	} catch {
		return undefined
	}
}

/** Stream every parseable record in the file, in order. */
export async function streamJsonl<T = Record<string, unknown>>(
	file: string,
	onRecord: (record: T, index: number) => void,
): Promise<void> {
	const stream = createReadStream(file, { encoding: "utf8" })
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
	let index = 0

	try {
		for await (const line of lines) {
			if (!line.trim()) {
				continue
			}

			const record = parseLine<T>(line)

			if (record) {
				onRecord(record, index++)
			}
		}
	} finally {
		lines.close()
		stream.destroy()

		// destroy() only begins the teardown; the descriptor closes a tick or
		// two later. Wait for it, so a caller may delete the file the moment
		// this resolves: on Windows an open handle keeps the directory entry
		// alive and a subsequent rmdir of the parent fails with ENOTEMPTY.
		if (!stream.closed) {
			await once(stream, "close")
		}
	}
}

function openOrUndefined(file: string): number | undefined {
	try {
		return fs.openSync(file, "r")
	} catch {
		return undefined
	}
}
