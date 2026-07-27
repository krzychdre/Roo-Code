import path from "path"
import os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"
import delay from "delay"

import type { ExperimentId } from "@roo-code/types"

import { formatLanguage } from "../../shared/language"
import { defaultModeSlug, getFullModeDetails } from "../../shared/modes"
import { getApiMetrics } from "../../shared/getApiMetrics"
import { listFiles } from "../../services/glob/list-files"
import { TerminalRegistry } from "../../integrations/terminal/TerminalRegistry"
import { Terminal } from "../../integrations/terminal/Terminal"
import { arePathsEqual } from "../../utils/path"
import { formatResponse } from "../prompts/responses"
import { getGitStatus } from "../../utils/git"

import { Task } from "../task/Task"
import { formatReminderSection } from "./reminder"

// Transient change-tracking per Task instance (never persisted, so a new or
// resumed task — including after a mode switch to a different context window —
// always starts from a full emission). Sections that rarely change between
// turns are omitted when identical to what the previous turn already sent:
// the model still has them in history, and re-sending churns every message
// with noise the model re-reads and re-reasons about each turn. See
// ai_plans/2026-07-12_glm-agent-loop-efficiency-implementation.md (WS-2).
interface EnvSectionSnapshot {
	visibleFiles: string
	openTabs: string
	mode: string
}

const lastEnvSnapshot = new WeakMap<Task, EnvSectionSnapshot>()

// The recursive workspace listing is by far the largest section: measured across
// 555 stored tasks it is 87.4% of all environment_details bytes in orchestrator
// mode and 51.9% in code mode. It is emitted on every *full* block, and
// TaskSubtasks#resumeAfterDelegation asks for a full block after every completed
// subtask — so 62.2% of orchestrator environment blocks carry a listing, against
// ~13% in the other modes. Those blocks live in the conversation history, so a
// long orchestration accumulates dozens of near-identical ~7.5 kB listings and
// re-sends all of them on every subsequent turn.
//
// Keyed per Task and never persisted, like lastEnvSnapshot: a resumed task, or
// one that switched to a mode with a different context window, starts from a
// full emission.
const lastFileDetails = new WeakMap<Task, string>()

/** Stands in for a listing the model already has verbatim earlier in this conversation. */
export const FILE_DETAILS_UNCHANGED_NOTE =
	"(Unchanged since the listing earlier in this conversation. Use list_files if you need a fresh view.)"

export async function getEnvironmentDetails(cline: Task, includeFileDetails: boolean = false) {
	let details = ""

	const clineProvider = cline.providerRef.deref()
	const state = await clineProvider?.getState()
	const { maxWorkspaceFiles = 200 } = state ?? {}

	// includeFileDetails marks task/resume/subtask starts — always emit the full
	// block there so the model's baseline never depends on dedup state.
	const prevSnapshot = includeFileDetails ? undefined : lastEnvSnapshot.get(cline)

	// It could be useful for cline to know if the user went from one or no
	// file to another between messages, so we include this context whenever
	// it changed since the previous turn.
	const visibleFilePaths = vscode.window.visibleTextEditors
		?.map((editor) => editor.document?.uri?.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cline.cwd, absolutePath))
		.slice(0, maxWorkspaceFiles)

	// Filter paths through rooIgnoreController
	const allowedVisibleFiles = cline.rooIgnoreController
		? cline.rooIgnoreController.filterPaths(visibleFilePaths)
		: visibleFilePaths.map((p) => p.toPosix()).join("\n")

	const visibleFilesText = Array.isArray(allowedVisibleFiles)
		? allowedVisibleFiles.join("\n")
		: allowedVisibleFiles || ""

	if (prevSnapshot === undefined || prevSnapshot.visibleFiles !== visibleFilesText) {
		if (visibleFilesText) {
			details += "\n\n# VSCode Visible Files"
			details += `\n${visibleFilesText}`
		} else if (prevSnapshot?.visibleFiles) {
			details += "\n\n# VSCode Visible Files\n(No visible files)"
		}
	}

	const { maxOpenTabsContext } = state ?? {}
	const maxTabs = maxOpenTabsContext ?? 20
	const openTabPaths = vscode.window.tabGroups.all
		.flatMap((group) => group.tabs)
		.filter((tab) => tab.input instanceof vscode.TabInputText)
		.map((tab) => (tab.input as vscode.TabInputText).uri.fsPath)
		.filter(Boolean)
		.map((absolutePath) => path.relative(cline.cwd, absolutePath).toPosix())
		.slice(0, maxTabs)

	// Filter paths through rooIgnoreController
	const allowedOpenTabs = cline.rooIgnoreController
		? cline.rooIgnoreController.filterPaths(openTabPaths)
		: openTabPaths.map((p) => p.toPosix()).join("\n")

	const openTabsText = Array.isArray(allowedOpenTabs) ? allowedOpenTabs.join("\n") : allowedOpenTabs || ""

	if (prevSnapshot === undefined || prevSnapshot.openTabs !== openTabsText) {
		if (openTabsText) {
			details += "\n\n# VSCode Open Tabs"
			details += `\n${openTabsText}`
		} else if (prevSnapshot?.openTabs) {
			details += "\n\n# VSCode Open Tabs\n(No open tabs)"
		}
	}

	// Get task-specific and background terminals.
	const busyTerminals = [
		...TerminalRegistry.getTerminals(true, cline.taskId),
		...TerminalRegistry.getBackgroundTerminals(true),
	]

	const inactiveTerminals = [
		...TerminalRegistry.getTerminals(false, cline.taskId),
		...TerminalRegistry.getBackgroundTerminals(false),
	]

	if (busyTerminals.length > 0) {
		if (cline.didEditFile) {
			await delay(300) // Delay after saving file to let terminals catch up.
		}

		// Wait for terminals to cool down.
		await pWaitFor(() => busyTerminals.every((t) => !TerminalRegistry.isProcessHot(t.id)), {
			interval: 100,
			timeout: 5_000,
		}).catch(() => {})
	}

	// Reset, this lets us know when to wait for saved files to update terminals.
	cline.didEditFile = false

	// Waiting for updated diagnostics lets terminal output be the most
	// up-to-date possible.
	let terminalDetails = ""

	if (busyTerminals.length > 0) {
		// Terminals are cool, let's retrieve their output.
		terminalDetails += "\n\n# Actively Running Terminals"

		for (const busyTerminal of busyTerminals) {
			const cwd = busyTerminal.getCurrentWorkingDirectory()
			terminalDetails += `\n## Terminal ${busyTerminal.id} (Active)`
			terminalDetails += `\n### Working Directory: \`${cwd}\``
			terminalDetails += `\n### Original command: \`${busyTerminal.getLastCommand()}\``
			let newOutput = TerminalRegistry.getUnretrievedOutput(busyTerminal.id)

			if (newOutput) {
				newOutput = Terminal.compressTerminalOutput(newOutput)
				terminalDetails += `\n### New Output\n${newOutput}`
			}
		}
	}

	// First check if any inactive terminals in this task have completed
	// processes with output.
	const terminalsWithOutput = inactiveTerminals.filter((terminal) => {
		const completedProcesses = terminal.getProcessesWithOutput()
		return completedProcesses.length > 0
	})

	// Only add the header if there are terminals with output.
	if (terminalsWithOutput.length > 0) {
		terminalDetails += "\n\n# Inactive Terminals with Completed Process Output"

		// Process each terminal with output.
		for (const inactiveTerminal of terminalsWithOutput) {
			let terminalOutputs: string[] = []

			// Get output from completed processes queue.
			const completedProcesses = inactiveTerminal.getProcessesWithOutput()

			for (const process of completedProcesses) {
				let output = process.getUnretrievedOutput()

				if (output) {
					output = Terminal.compressTerminalOutput(output)
					terminalOutputs.push(`Command: \`${process.command}\`\n${output}`)
				}
			}

			// Clean the queue after retrieving output.
			inactiveTerminal.cleanCompletedProcessQueue()

			// Add this terminal's outputs to the details.
			if (terminalOutputs.length > 0) {
				const cwd = inactiveTerminal.getCurrentWorkingDirectory()
				terminalDetails += `\n## Terminal ${inactiveTerminal.id} (Inactive)`
				terminalDetails += `\n### Working Directory: \`${cwd}\``
				terminalOutputs.forEach((output) => {
					terminalDetails += `\n### New Output\n${output}`
				})
			}
		}
	}

	// console.log(`[Task#getEnvironmentDetails] terminalDetails: ${terminalDetails}`)

	// Add recently modified files section.
	const recentlyModifiedFiles = cline.fileContextTracker.getAndClearRecentlyModifiedFiles()

	if (recentlyModifiedFiles.length > 0) {
		details +=
			"\n\n# Recently Modified Files\nThese files have been modified since you last accessed them (file was just edited so you may need to re-read it before editing):"
		for (const filePath of recentlyModifiedFiles) {
			details += `\n${filePath}`
		}
	}

	if (terminalDetails) {
		details += terminalDetails
	}

	// Time and cost are churn: they differ every turn while adding nothing the
	// task needs, so both default off. Time is still emitted on the first turn
	// (and on resume/subtask starts) so the model knows today's date.
	const { includeCurrentTime = false, includeCurrentCost = false, maxGitStatusFiles = 0 } = state ?? {}

	// Add current time information with timezone (every turn if enabled,
	// otherwise only on full emissions).
	if (includeCurrentTime || prevSnapshot === undefined) {
		const now = new Date()

		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60 // Convert to hours and invert sign to match conventional notation
		const timeZoneOffsetHours = Math.floor(Math.abs(timeZoneOffset))
		const timeZoneOffsetMinutes = Math.abs(Math.round((Math.abs(timeZoneOffset) - timeZoneOffsetHours) * 60))
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : "-"}${timeZoneOffsetHours}:${timeZoneOffsetMinutes.toString().padStart(2, "0")}`
		details += `\n\n# Current Time\nCurrent time in ISO 8601 UTC format: ${now.toISOString()}\nUser time zone: ${timeZone}, UTC${timeZoneOffsetStr}`
	}

	// Add git status information (if enabled with maxGitStatusFiles > 0).
	if (maxGitStatusFiles > 0) {
		const gitStatus = await getGitStatus(cline.cwd, maxGitStatusFiles)
		if (gitStatus) {
			details += `\n\n# Git Status\n${gitStatus}`
		}
	}

	// Add context tokens information (if enabled).
	if (includeCurrentCost) {
		const { totalCost } = getApiMetrics(cline.clineMessages)
		details += `\n\n# Current Cost\n${totalCost !== null ? `$${totalCost.toFixed(2)}` : "(Not available)"}`
	}

	const { id: modelId } = cline.api.getModel()

	// Add current mode and any mode-specific warnings.
	const {
		mode,
		customModes,
		customModePrompts,
		experiments = {} as Record<ExperimentId, boolean>,
		customInstructions: globalCustomInstructions,
		language,
	} = state ?? {}

	const currentMode = mode ?? defaultModeSlug

	const modeDetails = await getFullModeDetails(currentMode, customModes, customModePrompts, {
		cwd: cline.cwd,
		globalCustomInstructions,
		language: language ?? formatLanguage(vscode.env.language),
	})

	let modeSection = `\n\n# Current Mode\n`
	modeSection += `<slug>${currentMode}</slug>\n`
	modeSection += `<name>${modeDetails.name}</name>\n`
	modeSection += `<model>${modelId}</model>\n`

	// Re-emitted whenever mode or model changes (mode switches recompute
	// naturally since the comparison string embeds both).
	if (prevSnapshot === undefined || prevSnapshot.mode !== modeSection) {
		details += modeSection
	}

	lastEnvSnapshot.set(cline, {
		visibleFiles: visibleFilesText,
		openTabs: openTabsText,
		mode: modeSection,
	})

	if (includeFileDetails) {
		details += `\n\n# Current Workspace Directory (${cline.cwd.toPosix()}) Files\n`
		const isDesktop = arePathsEqual(cline.cwd, path.join(os.homedir(), "Desktop"))

		if (isDesktop) {
			// Don't want to immediately access desktop since it would show
			// permission popup.
			details += "(Desktop files not shown automatically. Use list_files to explore if needed.)"
		} else {
			const maxFiles = maxWorkspaceFiles ?? 200

			// Early return for limit of 0
			if (maxFiles === 0) {
				details += "(Workspace files context disabled. Use list_files to explore if needed.)"
			} else {
				const [files, didHitLimit] = await listFiles(cline.cwd, true, maxFiles)
				const { showRooIgnoredFiles = false } = state ?? {}

				const result = formatResponse.formatFilesList(
					cline.cwd,
					files,
					didHitLimit,
					cline.rooIgnoreController,
					showRooIgnoredFiles,
				)

				// Byte-identical to what this task already sent: point at that copy
				// instead of repeating it. Comparing content rather than counting
				// emissions means a subtask that actually created files still gets a
				// fresh listing, which is the only reason to re-emit at all.
				if (lastFileDetails.get(cline) === result) {
					details += FILE_DETAILS_UNCHANGED_NOTE
				} else {
					lastFileDetails.set(cline, result)
					details += result
				}
			}
		}
	}

	const todoListEnabled =
		state && typeof state.apiConfiguration?.todoListEnabled === "boolean"
			? state.apiConfiguration.todoListEnabled
			: true
	const reminderSection = todoListEnabled ? formatReminderSection(cline.todoList) : ""
	return `<environment_details>\n${details.trim()}\n${reminderSection}\n</environment_details>`
}
