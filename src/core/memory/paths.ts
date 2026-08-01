import * as path from "path"
import { homedir } from "os"

import { claudeConfigDir, claudeProjectCwd, claudeSlug } from "@roo-code/agent-interchange"

import { logger } from "../../utils/logging"

/**
 * Memory system path resolution.
 *
 * This is a native port of Claude Code's `memdir/paths.ts`, adapted to Roo Code:
 * - Storage root is VS Code's `context.globalStorageUri.fsPath` (set via
 *   {@link initMemoryPaths}) rather than `~/.claude`.
 * - Per-workspace keying uses a sanitized `cwd`, so multi-root workspaces and
 *   worktrees under different cwds get isolated memory dirs.
 * - `autoMemoryDirectory` is a full-path override honoured only from trusted
 *   sources (global/user/policy) — project settings must never redirect memory
 *   writes, or a malicious repo could point the carve-out at `~/.ssh`.
 *
 * The module is initialized once at extension activation via
 * {@link initMemoryPaths}. Call sites that build prompts / validate tool use
 * then call the path functions with the task `cwd`.
 */

const AUTO_MEM_DIRNAME = "memory"
const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md"

/**
 * The subset of global settings the memory module cares about. Kept narrow so
 * the module depends on a structural contract, not on `ContextProxy` directly
 * (keeps it unit-testable).
 */
export interface MemoryConfig {
	autoMemoryEnabled?: boolean
	autoMemoryDirectory?: string
	autoDreamEnabled?: boolean
	autoDreamMinHours?: number
	autoDreamMinSessions?: number
	memoryRecallEnabled?: boolean
	autoMemoryShareWithClaudeCode?: boolean
}

interface MemoryPathsState {
	/** Absolute base directory (typically `context.globalStorageUri.fsPath`). */
	globalStoragePath: string
	/** Accessor returning the live memory-related settings. */
	getConfig: () => MemoryConfig
}

let _state: MemoryPathsState | undefined

/** Whether {@link initMemoryPaths} has been called. */
export function isMemoryPathsInitialized(): boolean {
	return _state !== undefined
}

/**
 * Initialize the memory path module. Called once at extension activation.
 *
 * @param globalStoragePath `context.globalStorageUri.fsPath`
 * @param getConfig returns the current memory settings (reads through to
 *   `ContextProxy` / global state in production; a stub in tests).
 */
export function initMemoryPaths(globalStoragePath: string, getConfig: () => MemoryConfig): void {
	_state = { globalStoragePath, getConfig }
}

/** Reset module state — for tests only. */
export function resetMemoryPaths(): void {
	_state = undefined
	getAutoMemPathCache.clear()
	collisionResults.clear()
}

function requireState(): MemoryPathsState {
	if (!_state) {
		throw new Error(
			"Memory paths not initialized. Call initMemoryPaths(globalStoragePath, getConfig) at activation.",
		)
	}
	return _state
}

function isEnvTruthy(value: string | undefined): boolean {
	if (value === undefined) return false
	const v = value.trim().toLowerCase()
	return v === "1" || v === "true" || v === "yes"
}

function isEnvDefinedFalsy(value: string | undefined): boolean {
	if (value === undefined) return false
	const v = value.trim().toLowerCase()
	return v === "0" || v === "false" || v === "no"
}

/**
 * Master enable gate. Priority: env override > settings > default ON.
 *
 * `ROO_DISABLE_AUTO_MEMORY=1/true` forces memory OFF; `0/false` forces ON and
 * overrides settings. Mirrors `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.
 */
export function isAutoMemoryEnabled(): boolean {
	const envVal = process.env.ROO_DISABLE_AUTO_MEMORY
	if (isEnvTruthy(envVal)) return false
	if (isEnvDefinedFalsy(envVal)) return true
	const config = _state?.getConfig() ?? {}
	if (config.autoMemoryEnabled !== undefined) return config.autoMemoryEnabled
	return true
}

/**
 * Base directory under which per-project memory dirs live.
 *
 * `<globalStoragePath>/memory` by default. The trusted-source
 * `autoMemoryDirectory` setting overrides the *base* entirely (it is the
 * caller's responsibility — enforced in `ContextProxy` and the webview message
 * handler — to exclude project-scoped values for this key).
 */
export function getMemoryBaseDir(): string {
	const state = requireState()
	const override = state.getConfig().autoMemoryDirectory
	if (override && override.trim()) return validateMemoryPath(override)
	return path.join(state.globalStoragePath, "memory")
}

/**
 * Sanitize a cwd into a filesystem-safe directory segment. Non-alphanumerics
 * become `_` so `/home/user/my-project` -> `_home_user_my-project`.
 *
 * (Hyphens are preserved since they're valid in directory names and improve
 * readability.)
 */
export function sanitizeCwd(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9-]/g, "_")
}

// Memoize per-cwd so repeated calls during a task don't recompute.
const getAutoMemPathCache = new Map<string, string>()

/**
 * The per-workspace memory directory, WITH a trailing separator, NFC-normalized.
 * `<memoryBase>/projects/<sanitizedCwd>/memory/`.
 *
 * With `autoMemoryShareWithClaudeCode` on, it is Claude Code's directory for the
 * same workspace instead — `<claudeConfigDir>/projects/<claudeSlug(cwd)>/memory/`
 * — so both agents read and write one set of memories. The two layouts differ
 * only in the base and the per-project segment, which is what makes sharing a
 * path substitution rather than a migration.
 */
export function getAutoMemPath(cwd: string): string {
	const segments = memorySegmentsFor(cwd)
	// Keyed by the resolved layout, not just the cwd: toggling the sharing
	// setting (or the directory override) has to take effect without a reload.
	const cacheKey = segments.join("\u0000")
	const cached = getAutoMemPathCache.get(cacheKey)
	if (cached) return cached
	const dir = (path.join(...segments, AUTO_MEM_DIRNAME) + path.sep).normalize("NFC")
	getAutoMemPathCache.set(cacheKey, dir)
	return dir
}

/** `[base, "projects", <per-project segment>]` for the active layout. */
function memorySegmentsFor(cwd: string): [string, string, string] {
	if (isSharedWithClaudeCode()) {
		const base = claudeConfigDir()
		const segment = claudeSlug(cwd)
		if (hasSlugCollision(cwd, path.join(base, "projects", segment))) {
			return [getMemoryBaseDir(), "projects", sanitizeCwd(cwd)]
		}
		return [base, "projects", segment]
	}

	return [getMemoryBaseDir(), "projects", sanitizeCwd(cwd)]
}

/**
 * Sharing is off unless asked for, and an explicit `autoMemoryDirectory` always
 * wins: a user who named a path meant that path.
 */
function isSharedWithClaudeCode(): boolean {
	const config = _state?.getConfig() ?? {}
	if (config.autoMemoryDirectory && config.autoMemoryDirectory.trim()) return false
	return config.autoMemoryShareWithClaudeCode === true
}

/**
 * Claude Code's slug is lossy — `k3s_2025` and `k3s-2025` produce the same
 * directory name — so two workspaces can land on one shared memory dir. We
 * A proven mismatch is never safe to share. Fall back to Tumble's isolated
 * layout and warn once; an absent/unreadable store is not collision evidence.
 */
function hasSlugCollision(cwd: string, projectDir: string): boolean {
	const cacheKey = `${path.resolve(cwd)}\u0000${path.resolve(projectDir)}`
	const cached = collisionResults.get(cacheKey)
	if (cached !== undefined) return cached

	try {
		const recorded = claudeProjectCwd(projectDir)

		if (recorded && path.resolve(recorded) !== path.resolve(cwd)) {
			logger.warn(
				`[memory] shared memory dir ${projectDir} was created by Claude Code for ${recorded}, ` +
					`not ${cwd} — their paths collapse to the same directory name. Tumble Code will use its ` +
					`isolated memory directory for this workspace. Rename one workspace to restore sharing, ` +
					`or set autoMemoryDirectory to choose an explicit isolated location.`,
			)
			collisionResults.set(cacheKey, true)
			return true
		}
	} catch {
		// A store we cannot read is not evidence of a collision.
	}

	collisionResults.set(cacheKey, false)
	return false
}

const collisionResults = new Map<string, boolean>()

/** Path to the `MEMORY.md` index for a given cwd. */
export function getAutoMemEntrypoint(cwd: string): string {
	return path.join(getAutoMemPath(cwd), AUTO_MEM_ENTRYPOINT_NAME)
}

export const ENTRYPOINT_NAME = AUTO_MEM_ENTRYPOINT_NAME

/**
 * Containment check: does `absolutePath` live inside the memory dir for `cwd`?
 *
 * Normalizes the candidate path and uses the trailing-separator-bearing memory
 * dir so `/foo/team-evil` cannot match a memory dir at `/foo/team`.
 *
 * Returns `false` (never throws) when the module is uninitialized or memory is
 * disabled — this makes it safe to call from `validateToolUse` at any lifecycle
 * stage, including before extension activation and in unit tests that don't
 * initialize memory paths.
 */
export function isAutoMemPath(absolutePath: string, cwd: string): boolean {
	if (!_state) return false
	if (!isAutoMemoryEnabled()) return false
	if (typeof absolutePath !== "string" || absolutePath.length === 0) return false
	if (typeof cwd !== "string" || cwd.length === 0) return false
	const normalized = path.normalize(absolutePath)
	const memDir = getAutoMemPath(cwd) // ends with sep
	// `startsWith` on a sep-terminated prefix is the canonical containment check.
	if (normalized === memDir.slice(0, -1)) return true // the dir itself
	return normalized.startsWith(memDir)
}

/**
 * Validate a candidate memory base/override path. Rejects relative paths,
 * root/near-root paths, UNC paths, null bytes, and trivial tilde expansions
 * that resolve to `$HOME` — the path-traversal defense.
 *
 * Returns the normalized path with exactly one trailing separator,
 * NFC-normalized.
 *
 * @throws Error if the path is rejected.
 */
export function validateMemoryPath(candidate: string): string {
	if (typeof candidate !== "string" || candidate.length === 0) {
		throw new Error("Invalid memory directory: empty")
	}
	if (candidate.includes("\0")) {
		throw new Error("Invalid memory directory: contains null byte")
	}
	const home = homedir()
	const expanded = candidate.startsWith("~") ? path.join(home, candidate.slice(1)) : candidate
	// Reject resolving to the bare home directory.
	if (expanded === home || expanded === home + path.sep) {
		throw new Error("Invalid memory directory: resolves to home directory")
	}
	// Reject UNC paths (\\host\share or //host/share) — no remote redirects.
	// This must run before the isAbsolute check because posix treats backslash
	// as a literal char, so `\\host\share` is "relative" on posix and would
	// throw the wrong (absolute) error instead of the UNC error.
	if (/^[\\/][\\/]/.test(expanded)) {
		throw new Error("Invalid memory directory: UNC paths are not allowed")
	}
	if (!path.isAbsolute(expanded)) {
		throw new Error("Invalid memory directory: must be absolute")
	}
	// Reject drive-root ("C:\") and filesystem root ("/", length < 3 on most systems).
	const normalized = path.normalize(expanded)
	if (process.platform === "win32") {
		if (/^[a-zA-Z]:[\\/]$/.test(normalized)) {
			throw new Error("Invalid memory directory: drive root is not allowed")
		}
	} else {
		if (normalized === path.sep || normalized.length < 3) {
			throw new Error("Invalid memory directory: filesystem root is not allowed")
		}
	}
	// Ensure exactly one trailing separator.
	const withSep = normalized.endsWith(path.sep) ? normalized : normalized + path.sep
	return withSep.normalize("NFC")
}

/** Ensure the memory dir for `cwd` exists. Swallows EEXIST; logs real errors. */
export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
	const fs = await import("fs/promises")
	try {
		await fs.mkdir(memoryDir, { recursive: true })
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code
		if (code === "EEXIST") return
		logger.error(
			`[memory] ensureMemoryDirExists failed for ${memoryDir}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		)
	}
}
