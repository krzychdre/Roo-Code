/**
 * Utilities for handling path-related operations in mentions
 */

/**
 * Escape spaces in a path so it can be embedded in an `@`-mention token.
 *
 * This is a DISPLAY/TRANSPORT formatter for the webview chat-input grammar,
 * NOT a shell escaper. The mention syntax defined in
 * `src/shared/context-mentions.ts` (`mentionRegex`) treats a literal `\ `
 * (backslash-space) as an escaped space inside an `@/...` path token, and
 * `unescapeSpaces` reverses it. Downstream consumers (extension host) feed the
 * unescaped path to `path.resolve` + VS Code APIs (`openFile`,
 * `revealInExplorer`, `openExternal`); the value is NEVER interpolated into a
 * shell command string.
 *
 * Only spaces are escaped because that is the only character the mention
 * grammar requires escaping — the regex already excludes unescaped whitespace
 * from path tokens. Other shell metacharacters (`"`, `$`, backtick, `&`, `;`,
 * `|`, `\`) are not meaningful in this context and escaping them here would
 * corrupt the displayed path. CodeQL's `js/incomplete-sanitization` alert is a
 * false positive for this non-shell usage; the suppression below documents that
 * this function is intentionally not a general-purpose shell escaper.
 *
 * @param path The path to escape (assumed to contain unescaped spaces only)
 * @returns The path with each space replaced by `\ `
 */
// codeql[js/incomplete-sanitization]: This function intentionally escapes only
// spaces to satisfy the @-mention grammar in src/shared/context-mentions.ts.
// It is a display/transport formatter, not a shell escaper: its output is
// parsed back by `unescapeSpaces` and consumed by `path.resolve` + VS Code
// APIs (openFile / revealInExplorer / openExternal), never by a shell. No
// call site interpolates the result into a command string.
export function escapeSpacesForMention(path: string): string {
	return path.replace(/ /g, "\\ ")
}

/**
 * Converts an absolute path to a mention-friendly path
 * If the provided path starts with the current working directory,
 * it's converted to a relative path prefixed with @
 * Spaces in the path are escaped with backslashes
 *
 * @param path The path to convert
 * @param cwd The current working directory
 * @returns A mention-friendly path
 */
export function convertToMentionPath(path: string, cwd?: string): string {
	// Strip file:// or vscode-remote:// protocol if present
	let pathWithoutProtocol = path

	if (path.startsWith("file://")) {
		pathWithoutProtocol = path.substring(7)
	} else if (path.startsWith("vscode-remote://")) {
		const protocolStripped = path.substring("vscode-remote://".length)
		const firstSlashIndex = protocolStripped.indexOf("/")
		if (firstSlashIndex !== -1) {
			pathWithoutProtocol = protocolStripped.substring(firstSlashIndex + 1)
		} else {
			pathWithoutProtocol = ""
		}
	}

	try {
		pathWithoutProtocol = decodeURIComponent(pathWithoutProtocol)
		// Fix: Remove leading slash for Windows paths like /d:/...
		if (pathWithoutProtocol.startsWith("/") && pathWithoutProtocol[2] === ":") {
			pathWithoutProtocol = pathWithoutProtocol.substring(1)
		}
	} catch (e) {
		// Log error if decoding fails, but continue with the potentially problematic path
		console.error("Error decoding URI component in convertToMentionPath:", e, pathWithoutProtocol)
	}

	const normalizedPath = pathWithoutProtocol.replace(/\\/g, "/")
	let normalizedCwd = cwd ? cwd.replace(/\\/g, "/") : ""

	if (!normalizedCwd) {
		return pathWithoutProtocol
	}

	// Remove trailing slash from cwd if it exists
	if (normalizedCwd.endsWith("/")) {
		normalizedCwd = normalizedCwd.slice(0, -1)
	}

	// Always use case-insensitive comparison for path matching
	const lowerPath = normalizedPath.toLowerCase()
	const lowerCwd = normalizedCwd.toLowerCase()

	if (lowerPath.startsWith(lowerCwd)) {
		let relativePath = normalizedPath.substring(normalizedCwd.length)
		// Ensure there's a slash after the @ symbol when we create the mention path
		relativePath = relativePath.startsWith("/") ? relativePath : "/" + relativePath

		// Escape any spaces in the path with backslashes for the @-mention grammar
		const escapedRelativePath = escapeSpacesForMention(relativePath)

		return "@" + escapedRelativePath
	}

	return pathWithoutProtocol
}
