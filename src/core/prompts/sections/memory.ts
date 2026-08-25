/**
 * Memory system-prompt sections.
 *
 * Two thin wrappers over [`memoryPrompt.ts`](../../memory/memoryPrompt):
 * - {@link getMemorySection} - the behavioral instructions (what/when/how to
 *   save, what NOT to save, the type taxonomy).
 * - {@link getMemoryIndexSection} - the truncated `MEMORY.md` index content.
 *
 * Both close the STABLE HEAD in `system.ts` (WS-F): they are the last two
 * entries of `stableHead`, after `getSystemInfoSection`, because they are
 * mode-independent and a mode switch should keep them cached. Anything printed
 * after them lives in the variable tail.
 *
 * Both are `async` because they read `MEMORY.md` from disk; both return "" when
 * memory is disabled so the caller can treat the result as an optional insert.
 */

import { loadMemoryPrompt, loadMemoryIndex } from "../../memory/memoryPrompt"

/** The behavioral memory prompt (or "" if memory is disabled). */
export async function getMemorySection(cwd: string): Promise<string> {
	return loadMemoryPrompt(cwd)
}

/** The truncated `MEMORY.md` index content (or "" if disabled / not yet created). */
export async function getMemoryIndexSection(cwd: string): Promise<string> {
	return loadMemoryIndex(cwd)
}
