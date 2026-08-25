/**
 * Escape a string so it is safe to interpolate as a single markdown table cell.
 *
 * Backslash is escaped first so a literal `\` cannot combine with a following
 * escaped `|` to form an ambiguous `\|`; the pipe is escaped next; then
 * newlines (both `\n` and `\r\n`) are collapsed to a space so the cell cannot
 * spill onto a second row. Order matters: backslash before pipe, otherwise
 * `a\|b` would become `a\ \|b` instead of `a\\|b`.
 */
export function escapeMarkdownTableCell(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}
