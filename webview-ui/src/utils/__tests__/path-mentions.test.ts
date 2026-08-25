import { escapeSpacesForMention, convertToMentionPath } from "../path-mentions"
import { mentionRegexGlobal, unescapeSpaces } from "@roo/context-mentions"

describe("Path Mentions Utilities", () => {
	describe("escapeSpacesForMention", () => {
		it("should replace spaces with escaped spaces", () => {
			expect(escapeSpacesForMention("file with spaces.txt")).toBe("file\\ with\\ spaces.txt")
			expect(escapeSpacesForMention("/path/to/another file/")).toBe("/path/to/another\\ file/")
			expect(escapeSpacesForMention("single space")).toBe("single\\ space")
		})

		it("should handle paths without spaces", () => {
			expect(escapeSpacesForMention("file_without_spaces.txt")).toBe("file_without_spaces.txt")
			expect(escapeSpacesForMention("/path/to/normal/file")).toBe("/path/to/normal/file")
		})

		it("should handle multiple spaces", () => {
			expect(escapeSpacesForMention("a b c d.txt")).toBe("a\\ b\\ c\\ d.txt")
		})

		it("should handle leading/trailing spaces", () => {
			expect(escapeSpacesForMention(" leading space")).toBe("\\ leading\\ space")
			expect(escapeSpacesForMention("trailing space ")).toBe("trailing\\ space\\ ")
		})

		it("should handle empty string", () => {
			expect(escapeSpacesForMention("")).toBe("")
		})

		it("should not affect already escaped spaces", () => {
			// This function assumes input spaces are not already escaped
			// The function will re-escape the backslashes, resulting in double-escaped spaces
			expect(escapeSpacesForMention("file\\ with\\ spaces.txt")).toBe("file\\\\ with\\\\ spaces.txt")
		})

		it("should not escape other characters", () => {
			expect(escapeSpacesForMention("path/with/slashes")).toBe("path/with/slashes")
			expect(escapeSpacesForMention("file-with-hyphens.txt")).toBe("file-with-hyphens.txt")
		})

		it("is a mention-grammar formatter, not a shell escaper (CodeQL #6 regression)", () => {
			// The escaped value, embedded in an @-mention token, must be matched by
			// mentionRegex (src/shared/context-mentions.ts) and round-trip back to the
			// original path via unescapeSpaces. This proves the `\ ` escaping serves
			// the mention grammar, not shell interpolation.
			const original = "/src/file with spaces & $ HOME `cmd`.txt"
			const escaped = escapeSpacesForMention(original)
			const mentionToken = `@${escaped}`

			// 1. The mention regex recognises the whole token.
			const matches = [...mentionToken.matchAll(mentionRegexGlobal)]
			expect(matches).toHaveLength(1)
			expect(matches[0][1]).toBe(escaped)

			// 2. unescapeSpaces inverts the transformation exactly.
			expect(unescapeSpaces(matches[0][1])).toBe(original)

			// 3. Only spaces are escaped; shell metacharacters pass through verbatim
			//    (they are not meaningful in the mention grammar). If a shell escaper
			//    were intended, these would have been altered.
			expect(escaped).toBe("/src/file\\ with\\ spaces & $ HOME `cmd`.txt")
			expect(escaped).not.toContain('"')
			expect(escaped).not.toContain("\\$")
			expect(escaped).not.toContain("\\`")
			expect(escaped).not.toContain("\\&")
		})
	})

	describe("convertToMentionPath", () => {
		const MOCK_CWD_POSIX = "/Users/test/project"
		const MOCK_CWD_WIN = "C:\\Users\\test\\project"

		it("should convert absolute posix path within cwd to relative mention path and escape spaces", () => {
			const absPath = "/Users/test/project/src/file with spaces.ts"
			expect(convertToMentionPath(absPath, MOCK_CWD_POSIX)).toBe("@/src/file\\ with\\ spaces.ts")
		})

		it("should convert absolute windows path within cwd to relative mention path and escape spaces", () => {
			const absPath = "C:\\Users\\test\\project\\src\\file with spaces.ts"
			expect(convertToMentionPath(absPath, MOCK_CWD_WIN)).toBe("@/src/file\\ with\\ spaces.ts")
		})

		it("should handle paths already relative to cwd (though input is usually absolute)", () => {
			const relPath = "src/another file.js" // Assuming this might be passed somehow
			// It won't match startsWith(cwd), so it should return the original path (but normalized)
			expect(convertToMentionPath(relPath, MOCK_CWD_POSIX)).toBe("src/another file.js")
		})

		it("should handle paths outside cwd by returning the original path (normalized)", () => {
			const absPath = "/Users/other/file.txt"
			expect(convertToMentionPath(absPath, MOCK_CWD_POSIX)).toBe("/Users/other/file.txt")
			// Since we can't control the implementation of path normalization in this test,
			// let's accept either form of path separators (/ or \) for the Windows path test
			const winPath = "D:\\another\\folder\\file.txt"
			const result = convertToMentionPath(winPath, MOCK_CWD_WIN)
			// Check that the path was returned without being converted to a mention
			expect(result.startsWith("@")).toBe(false)
			// Check the path contains the expected components regardless of separator
			expect(result.toLowerCase()).toContain("d:")
			expect(result.toLowerCase()).toContain("another")
			expect(result.toLowerCase()).toContain("folder")
			expect(result.toLowerCase()).toContain("file.txt")
		})

		it("should handle paths with no spaces correctly", () => {
			const absPath = "/Users/test/project/src/normal.ts"
			expect(convertToMentionPath(absPath, MOCK_CWD_POSIX)).toBe("@/src/normal.ts")
		})

		it("should add leading slash if missing after cwd removal", () => {
			const absPath = "/Users/test/projectfile.txt" // Edge case: file directly in project root
			const cwd = "/Users/test/project"
			expect(convertToMentionPath(absPath, cwd)).toBe("@/file.txt") // Should still add '/'
		})

		it("should handle cwd with trailing slash", () => {
			const absPath = "/Users/test/project/src/file with spaces.ts"
			const cwdWithSlash = MOCK_CWD_POSIX + "/"
			expect(convertToMentionPath(absPath, cwdWithSlash)).toBe("@/src/file\\ with\\ spaces.ts")
		})

		it("should handle case-insensitive matching for cwd", () => {
			const absPath = "/users/test/project/src/file with spaces.ts" // Lowercase path
			expect(convertToMentionPath(absPath, MOCK_CWD_POSIX)).toBe("@/src/file\\ with\\ spaces.ts") // Should still match uppercase CWD
			const absPathUpper = "/USERS/TEST/PROJECT/src/file.ts" // Uppercase path
			expect(convertToMentionPath(absPathUpper, MOCK_CWD_POSIX.toLowerCase())).toBe("@/src/file.ts") // Should match lowercase CWD
		})

		it("should return original path if cwd is not provided", () => {
			const absPath = "/Users/test/project/src/file with spaces.ts"
			expect(convertToMentionPath(absPath, undefined)).toBe("/Users/test/project/src/file with spaces.ts")
		})
	})
})
