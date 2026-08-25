import path from "path"
import delay from "delay"
import fs from "fs/promises"

import { type ClineSayTool, DEFAULT_WRITE_DELAY_MS } from "@roo-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { RecordSource } from "../context-tracking/FileContextTrackerTypes"
import { fileExistsAtPath, createDirectoriesForFile } from "../../utils/fs"
import { stripLineNumbers, everyLineHasLineNumbers } from "../../integrations/misc/extract-text"
import { getReadablePath } from "../../utils/path"
import { isPathOutsideWorkspace } from "../../utils/pathUtils"
import { unescapeHtmlEntities } from "../../utils/text-normalization"
import { EXPERIMENT_IDS, experiments } from "../../shared/experiments"
import { pauseForPlanReviewIfNeeded } from "../plan-review/planReviewPause"
import { convertNewFileToUnifiedDiff, computeDiffStats, sanitizeUnifiedDiff } from "../diff/stats"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks } from "./BaseTool"

interface WriteToFileParams {
	path: string
	content: string
}

export class WriteToFileTool extends BaseTool<"write_to_file"> {
	readonly name = "write_to_file" as const

	/**
	 * Memo of the last path validated during partial streaming and its access result.
	 * Avoids re-validating (and re-emitting any error UI) on every streamed chunk
	 * for the same path. Reset by resetPartialState().
	 */
	private lastValidatedPartialPath: string | undefined = undefined
	private lastPartialAccessAllowed: boolean | undefined = undefined

	/**
	 * The relPath that diffViewProvider.editType was computed for.
	 * During partial streaming, partial-json may produce a truncated path that
	 * differs from the final parsed path.  If editType was set for a different
	 * path than the final one, execute() must re-check file existence rather than
	 * trust the stale value.  Reset by resetPartialState().
	 */
	private editTypePath: string | undefined = undefined

	async execute(params: WriteToFileParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { pushToolResult, handleError, askApproval, toolCallId } = callbacks
		const relPath = params.path
		// Coerce content to string safely — weak models can emit null/numbers.
		let newContent = typeof params.content === "string" ? params.content : ""

		if (typeof relPath !== "string" || !relPath) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "path"))
			await task.diffViewProvider.reset()
			return
		}

		if (params.content === undefined) {
			task.consecutiveMistakeCount++
			task.recordToolError("write_to_file")
			pushToolResult(await task.sayAndCreateMissingParamError("write_to_file", "content"))
			await task.diffViewProvider.reset()
			return
		}

		const accessAllowed = task.rooIgnoreController?.validateAccess(relPath)

		if (!accessAllowed) {
			await task.say("rooignore_error", relPath)
			pushToolResult(formatResponse.rooIgnoreError(relPath))
			return
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath) || false

		let fileExists: boolean
		const absolutePath = path.resolve(task.cwd, relPath)

		// TL-2: If editType was set during the partial phase but for a DIFFERENT
		// path than the final relPath (partial-json truncated-string behavior),
		// the cached editType is stale and must not be trusted.  Re-check file
		// existence for the actual final path.  When editTypePath is undefined
		// (editType set externally, not by handlePartial), trust the cache.
		if (
			task.diffViewProvider.editType !== undefined &&
			(this.editTypePath === undefined || this.editTypePath === relPath)
		) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
			this.editTypePath = relPath
		}

		// Create parent directories early for new files to prevent ENOENT errors
		// in subsequent operations (e.g., diffViewProvider.open, fs.readFile)
		if (!fileExists) {
			await createDirectoriesForFile(absolutePath)
		}

		if (newContent.startsWith("```")) {
			newContent = newContent.split("\n").slice(1).join("\n")
		}

		if (newContent.endsWith("```")) {
			newContent = newContent.split("\n").slice(0, -1).join("\n")
		}

		if (!task.api.getModel().id.includes("claude")) {
			newContent = unescapeHtmlEntities(newContent)
		}

		const fullPath = relPath ? path.resolve(task.cwd, relPath) : ""
		const isOutsideWorkspace = isPathOutsideWorkspace(fullPath)

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(task.cwd, relPath),
			content: newContent,
			isOutsideWorkspace,
			isProtected: isWriteProtected,
			// Stamp the native tool-call id so the finalized-duplicate dedup links
			// this complete card to its streaming placeholder, whose content
			// differs (raw newContent vs the unified diff shown on approval).
			toolCallId,
		}

		try {
			task.consecutiveMistakeCount = 0

			const provider = task.providerRef.deref()
			const state = await provider?.getState()
			const diagnosticsEnabled = state?.diagnosticsEnabled ?? true
			const writeDelayMs = state?.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS
			// Background/memory tasks (`silentWrites`) reuse the focus-disruption
			// path: it writes straight to disk without opening a diff editor tab.
			const isPreventFocusDisruptionEnabled =
				task.silentWrites ||
				experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)

			if (isPreventFocusDisruptionEnabled) {
				task.diffViewProvider.editType = fileExists ? "modify" : "create"
				if (fileExists) {
					const absolutePath = path.resolve(task.cwd, relPath)
					task.diffViewProvider.originalContent = await fs.readFile(absolutePath, "utf-8")
				} else {
					task.diffViewProvider.originalContent = ""
				}

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					return
				}

				await task.diffViewProvider.saveDirectly(relPath, newContent, false, diagnosticsEnabled, writeDelayMs)
			} else {
				if (!task.diffViewProvider.isEditing) {
					const partialMessage = JSON.stringify(sharedMessageProps)
					await task.ask("tool", partialMessage, true).catch(() => {})
					await task.diffViewProvider.open(relPath)
				}

				await task.diffViewProvider.update(
					everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
					true,
				)

				await delay(300)
				task.diffViewProvider.scrollToFirstDiff()

				let unified = fileExists
					? formatResponse.createPrettyPatch(relPath, task.diffViewProvider.originalContent, newContent)
					: convertNewFileToUnifiedDiff(newContent, relPath)
				unified = sanitizeUnifiedDiff(unified)
				const completeMessage = JSON.stringify({
					...sharedMessageProps,
					content: unified,
					diffStats: computeDiffStats(unified) || undefined,
				} satisfies ClineSayTool)

				const didApprove = await askApproval("tool", completeMessage, undefined, isWriteProtected)

				if (!didApprove) {
					await task.diffViewProvider.revertChanges()
					return
				}

				await task.diffViewProvider.saveChanges(diagnosticsEnabled, writeDelayMs)
			}

			if (relPath) {
				await task.fileContextTracker.trackFileContext(relPath, "roo_edited" as RecordSource)
			}

			task.didEditFile = true

			const message = await task.diffViewProvider.pushToolWriteResult(task, task.cwd, !fileExists)

			const reviewNote = await pauseForPlanReviewIfNeeded(task, relPath)
			pushToolResult(reviewNote ? `${message}\n\n${reviewNote}` : message)

			await task.diffViewProvider.reset()
			this.resetPartialState()

			task.processQueuedMessages()

			return
		} catch (error) {
			await handleError("writing file", error as Error, this.name)
			await task.diffViewProvider.reset()
			this.resetPartialState()
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"write_to_file">): Promise<void> {
		const relPath: string | undefined = block.params.path
		let newContent: string | undefined = block.params.content

		// Wait for path to stabilize before showing UI (prevents truncated paths)
		if (!this.hasPathStabilized(relPath) || newContent === undefined) {
			return
		}

		const provider = task.providerRef.deref()
		const state = await provider?.getState()
		const isPreventFocusDisruptionEnabled =
			task.silentWrites ||
			experiments.isEnabled(state?.experiments ?? {}, EXPERIMENT_IDS.PREVENT_FOCUS_DISRUPTION)

		if (isPreventFocusDisruptionEnabled) {
			return
		}

		// --- TL-6: validate access BEFORE opening the diff editor ---
		// During partial streaming, a (weak or manipulated) model could stream a
		// roo-ignored secrets file or a path outside the workspace.  Opening the
		// diff editor reads the file's content into the UI before execute()'s
		// access checks run.  Guard the partial phase by skipping open() when
		// access is denied or the path is outside the workspace — execute() will
		// produce the proper structured error in the final phase.
		const absolutePath = path.resolve(task.cwd, relPath!)

		// Memoize the access check result per path so repeated chunks for the same
		// rejected path don't re-validate (and won't spam any UI).
		let accessAllowed: boolean
		if (this.lastValidatedPartialPath === relPath && this.lastPartialAccessAllowed !== undefined) {
			accessAllowed = this.lastPartialAccessAllowed
		} else {
			accessAllowed = task.rooIgnoreController?.validateAccess(relPath!) ?? true
			this.lastValidatedPartialPath = relPath
			this.lastPartialAccessAllowed = accessAllowed
		}

		if (!accessAllowed) {
			// Skip opening diff editor; execute() will emit the roo-ignore error.
			return
		}

		const isOutsideWorkspace = isPathOutsideWorkspace(absolutePath)
		if (isOutsideWorkspace) {
			// Outside-workspace writes may be legitimate with approval, but in the
			// partial phase we skip opening the diff editor — defer to execute()'s
			// approval flow which can properly gate the operation.
			return
		}

		// relPath is guaranteed non-null after hasPathStabilized
		let fileExists: boolean

		if (
			task.diffViewProvider.editType !== undefined &&
			(this.editTypePath === undefined || this.editTypePath === relPath)
		) {
			fileExists = task.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			task.diffViewProvider.editType = fileExists ? "modify" : "create"
			this.editTypePath = relPath
		}

		// Create parent directories early for new files to prevent ENOENT errors
		// in subsequent operations (e.g., diffViewProvider.open)
		if (!fileExists) {
			await createDirectoriesForFile(absolutePath)
		}

		const isWriteProtected = task.rooProtectedController?.isWriteProtected(relPath!) || false

		const sharedMessageProps: ClineSayTool = {
			tool: fileExists ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(task.cwd, relPath!),
			content: newContent || "",
			isOutsideWorkspace,
			isProtected: isWriteProtected,
			// Stamp the native tool-call id so this placeholder links to the
			// later complete card under the finalized-duplicate dedup.
			toolCallId: block.id,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})

		if (newContent) {
			if (!task.diffViewProvider.isEditing) {
				await task.diffViewProvider.open(relPath!)
			}

			await task.diffViewProvider.update(
				everyLineHasLineNumbers(newContent) ? stripLineNumbers(newContent) : newContent,
				false,
			)
		}
	}

	override resetPartialState(): void {
		super.resetPartialState()
		this.lastValidatedPartialPath = undefined
		this.lastPartialAccessAllowed = undefined
		this.editTypePath = undefined
	}
}

export const writeToFileTool = new WriteToFileTool()
